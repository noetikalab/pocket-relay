import type { IChannel } from './IChannel'
import { LarkChannel } from './lark/LarkChannel'
import { QQChannel } from './qq/QQChannel'

/**
 * 所有已实现的 channel 类型。
 *
 * 新增 channel 时只需在此处添加类型，并在 createChannel / CHANNEL_REQUIRED_CONFIG 中补充对应逻辑。
 * core 层（start.ts）无需改动。
 */
export const SUPPORTED_CHANNELS = ['lark', 'qq'] as const

/** Channel 类型联合 */
export type ChannelType = (typeof SUPPORTED_CHANNELS)[number]

/**
 * 每个 channel 在启动时必须提供的配置项键名。
 *
 * 用于 core 层统一做缺失配置校验，避免各 channel 的校验逻辑散落在 start.ts 里。
 */
export const CHANNEL_REQUIRED_CONFIG: Record<ChannelType, string[]> = {
  lark: ['larkAppId', 'larkAppSecret'],
  qq: ['qqAppId', 'qqAppSecret']
}

/**
 * Channel 工厂函数 — 根据 channelType 创建对应的 IChannel 实例。
 *
 * @param channelType 已验证合法的 channel 类型
 * @param config 合并后的配置对象（已通过 CHANNEL_REQUIRED_CONFIG 校验）
 */
export function createChannel(channelType: ChannelType, config: Record<string, string>): IChannel {
  switch (channelType) {
    case 'lark':
      return new LarkChannel({ appId: config.larkAppId, appSecret: config.larkAppSecret })
    case 'qq':
      return new QQChannel({ appId: config.qqAppId, appSecret: config.qqAppSecret })
  }
}
