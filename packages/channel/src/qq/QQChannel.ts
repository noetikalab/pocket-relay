import WebSocket from 'ws'
import type { IncomingMessage, OutgoingMessage } from '@pocket-relay/types'
import type { IChannel } from '../IChannel'
import { extractText, splitMessage } from './QQFormatter'

const QQ_API_BASE = 'https://api.sgroup.qq.com'
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const QQ_GATEWAY_URL = `${QQ_API_BASE}/gateway`

/** QQ Bot v2 WebSocket OpCode */
const enum OpCode {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  RESUME = 6,
  RECONNECT = 7,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11
}

/** 群聊消息来源标识 */
interface QQGroupMessage {
  id: string
  group_openid: string
  content: string
  timestamp: string
  author: { member_openid: string }
}

/** 私聊消息来源标识 */
interface QQC2CMessage {
  id: string
  content: string
  timestamp: string
  author: { user_openid: string }
}

/**
 * QQ 机器人通信通道实现（群聊 + 私聊）。
 *
 * 使用 QQ 开放平台 v2 API：
 * - WebSocket 长连接接收消息（intent: 1<<25，覆盖 GROUP_AT_MESSAGE_CREATE 和 C2C_MESSAGE_CREATE）
 * - REST API 发送消息（被动回复，需要原始 msg_id）
 * - Access Token 自动刷新（有效期 7200s，提前 60s 刷新）
 *
 * chatId 编码规则：
 * - 群聊：`group:{group_openid}`
 * - 私聊：`c2c:{user_openid}`
 */
export class QQChannel implements IChannel {
  private appId: string
  private appSecret: string
  private accessToken = ''
  private tokenExpiresAt = 0
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sessionId = ''
  private seq = 0
  private messageHandler: ((msg: IncomingMessage) => void) | null = null

  // 幂等去重：记录最近处理过的 message_id
  private seenMessageIds = new Set<string>()
  private readonly MAX_SEEN = 1000

  // 最近收到的消息 id，用于被动回复（QQ 要求回复时带上原始 msg_id）
  private lastMsgIds = new Map<string, string>()

  // 每个 chatId 的 msg_seq 计数器，针对同一 msg_id 必须全局递增，不能重置
  private msgSeqCounters = new Map<string, number>()

  constructor(config: { appId: string; appSecret: string }) {
    this.appId = config.appId
    this.appSecret = config.appSecret
  }

  async connect(): Promise<void> {
    await this._refreshToken()
    const wsUrl = await this._getGatewayUrl()
    await this._connectWs(wsUrl)
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const chunks = splitMessage(msg.text)
    for (const chunk of chunks) {
      const seq = this._nextMsgSeq(msg.chatId)
      await this._sendChunk(msg.chatId, chunk, seq)
    }
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close()
    this.ws = null
  }

  // ── 内部：Token 管理 ──────────────────────────────────────────────

  private async _refreshToken(): Promise<void> {
    const res = await fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret })
    })
    if (!res.ok) throw new Error(`QQ token 获取失败: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { access_token: string; expires_in: number }
    this.accessToken = data.access_token
    // 提前 120s 刷新，避免边界情况
    this.tokenExpiresAt = Date.now() + (data.expires_in - 120) * 1000
    console.log('[QQChannel] Access token 已刷新，有效期:', data.expires_in, 's')
  }

  private async _ensureToken(): Promise<void> {
    if (Date.now() >= this.tokenExpiresAt) {
      await this._refreshToken()
    }
  }

  // ── 内部：WebSocket 连接 ──────────────────────────────────────────

  private async _getGatewayUrl(): Promise<string> {
    const res = await fetch(QQ_GATEWAY_URL, {
      headers: { Authorization: `QQBot ${this.accessToken}` }
    })
    if (!res.ok) throw new Error(`QQ gateway 获取失败: ${res.status}`)
    const data = (await res.json()) as { url: string }
    return data.url
  }

  private _connectWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws

      ws.on('open', () => console.log('[QQChannel] WebSocket 已连接'))

      ws.on('message', async (raw: Buffer) => {
        const payload = JSON.parse(raw.toString()) as {
          op: number
          d?: unknown
          s?: number
          t?: string
        }

        if (payload.s) this.seq = payload.s

        switch (payload.op) {
          case OpCode.HELLO: {
            const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval
            this._startHeartbeat(interval)
            await this._identify()
            break
          }
          case OpCode.DISPATCH:
            if (payload.t === 'READY') {
              this.sessionId = (payload.d as { session_id: string }).session_id
              console.log('[QQChannel] 已就绪，session_id:', this.sessionId)
              resolve()
            } else {
              await this._handleDispatch(payload.t ?? '', payload.d)
            }
            break
          case OpCode.RECONNECT:
            console.log('[QQChannel] 收到 RECONNECT，重连中...')
            await this._resume()
            break
          case OpCode.INVALID_SESSION:
            console.log('[QQChannel] Session 失效，重新 identify')
            await this._identify()
            break
          case OpCode.HEARTBEAT_ACK:
            break
        }
      })

      ws.on('error', err => {
        console.error('[QQChannel] WebSocket 错误:', err)
        reject(err)
      })

      ws.on('close', (code, reason) => {
        console.log('[QQChannel] WebSocket 关闭:', code, reason.toString())
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      })
    })
  }

  private _startHeartbeat(interval: number): void {
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: OpCode.HEARTBEAT, d: this.seq || null }))
    }, interval)
  }

  private async _identify(): Promise<void> {
    await this._ensureToken()
    this.ws?.send(
      JSON.stringify({
        op: OpCode.IDENTIFY,
        d: {
          token: `QQBot ${this.accessToken}`,
          // 1<<25 = 33554432，覆盖 GROUP_AT_MESSAGE_CREATE 和 C2C_MESSAGE_CREATE
          intents: 1 << 25,
          shard: [0, 1],
          properties: {}
        }
      })
    )
  }

  private async _resume(): Promise<void> {
    await this._ensureToken()
    this.ws?.send(
      JSON.stringify({
        op: OpCode.RESUME,
        d: {
          token: `QQBot ${this.accessToken}`,
          session_id: this.sessionId,
          seq: this.seq
        }
      })
    )
  }

  // ── 内部：消息处理 ────────────────────────────────────────────────

  private async _handleDispatch(eventType: string, data: unknown): Promise<void> {
    if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      await this._handleGroupMessage(data as QQGroupMessage)
    } else if (eventType === 'C2C_MESSAGE_CREATE') {
      await this._handleC2CMessage(data as QQC2CMessage)
    }
  }

  private async _handleGroupMessage(data: QQGroupMessage): Promise<void> {
    const { id, group_openid, content, author } = data
    if (this._isDuplicate(id)) return

    const text = extractText(content)
    if (!text) return

    // chatId 编码：群聊用 group: 前缀，send() 时据此路由
    const chatId = `group:${group_openid}`
    // 新消息到来时重置 seq 计数器，每条 msg_id 对应的回复序号从 1 开始
    this.lastMsgIds.set(chatId, id)
    this.msgSeqCounters.set(chatId, 0)

    this.messageHandler?.({
      messageId: id,
      chatId,
      senderId: author.member_openid,
      text,
      receivedAt: Date.now()
    })
  }

  private async _handleC2CMessage(data: QQC2CMessage): Promise<void> {
    const { id, content, author } = data
    if (this._isDuplicate(id)) return

    const text = extractText(content)
    if (!text) return

    const chatId = `c2c:${author.user_openid}`
    this.lastMsgIds.set(chatId, id)
    this.msgSeqCounters.set(chatId, 0)

    this.messageHandler?.({
      messageId: id,
      chatId,
      senderId: author.user_openid,
      text,
      receivedAt: Date.now()
    })
  }

  // ── 内部：发送消息 ────────────────────────────────────────────────

  private async _sendChunk(chatId: string, text: string, seq: number): Promise<void> {
    await this._ensureToken()
    const msgId = this.lastMsgIds.get(chatId)

    let url: string
    if (chatId.startsWith('group:')) {
      const groupOpenid = chatId.slice(6)
      url = `${QQ_API_BASE}/v2/groups/${groupOpenid}/messages`
    } else if (chatId.startsWith('c2c:')) {
      const userOpenid = chatId.slice(4)
      url = `${QQ_API_BASE}/v2/users/${userOpenid}/messages`
    } else {
      console.error('[QQChannel] 未知 chatId 格式:', chatId)
      return
    }

    const body: Record<string, unknown> = {
      content: text,
      msg_type: 0,
      msg_seq: seq
    }
    // 被动回复需要带上原始 msg_id，否则 QQ 会拒绝（主动消息需要额外权限）
    if (msgId) body.msg_id = msgId

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[QQChannel] 发送消息失败:', res.status, err)
    }
  }

  private _isDuplicate(id: string): boolean {
    if (this.seenMessageIds.has(id)) return true
    this.seenMessageIds.add(id)
    if (this.seenMessageIds.size > this.MAX_SEEN) {
      const entries = [...this.seenMessageIds]
      entries.slice(0, this.MAX_SEEN / 2).forEach(e => this.seenMessageIds.delete(e))
    }
    return false
  }

  private _nextMsgSeq(chatId: string): number {
    const next = (this.msgSeqCounters.get(chatId) ?? 0) + 1
    this.msgSeqCounters.set(chatId, next)
    return next
  }
}
