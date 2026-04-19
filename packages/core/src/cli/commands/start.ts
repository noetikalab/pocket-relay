import { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import type { ExecutorConfig } from '@pocket-relay/types'
import { SUPPORTED_CHANNELS, CHANNEL_REQUIRED_CONFIG, createChannel } from '@pocket-relay/channel'
import type { ChannelType } from '@pocket-relay/channel'
import { ClaudeCodeExecutor, ClaudeCodeAcpExecutor } from '@pocket-relay/executor'
import { Daemon } from '../../daemon'
import { colors, logInfo, logSuccess, logError } from '../../logger'
import { loadGlobalConfig, loadLocalConfig, mergeConfig } from '../../config'

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('启动 PocketRelay 守护进程')
    .option('--lark-app-id <id>', '飞书 App ID')
    .option('--lark-app-secret <secret>', '飞书 App Secret')
    .option('--qq-app-id <id>', 'QQ 机器人 App ID')
    .option('--qq-app-secret <secret>', 'QQ 机器人 App Secret')
    .option('--claude-bin <path>', 'Claude Code 可执行文件路径')
    .option('--claude-cwd <path>', 'Claude Code 工作目录')
    .option('--task-timeout-ms <ms>', '任务超时时间（毫秒）')
    .option('--executor-mode <mode>', '执行器模式：spawn（默认）或 acp（交互模式）', 'spawn')
    .option('--channel <type>', '通信通道类型：lark（默认）', 'lark')
    .action(startAction)
}

async function startAction(options: any) {
  const cwd = process.cwd()
  const globalConfig = loadGlobalConfig()
  const localConfig = loadLocalConfig(cwd)
  const config = mergeConfig(globalConfig, localConfig, options)

  const claudeBin = config.claudeBin!
  const claudeCwd = config.claudeCwd ?? cwd
  const timeoutMs = config.taskTimeoutMs!
  const executorMode: string = options.executorMode ?? 'spawn'
  const channelType = (options.channel ?? 'lark') as ChannelType

  // 检查 channel 是否支持（由 channel 包统一维护列表）
  if (!SUPPORTED_CHANNELS.includes(channelType)) {
    logError(`通道 "${channelType}" 暂未实现，当前支持：${SUPPORTED_CHANNELS.join(', ')}`)
    process.exit(1)
  }

  // 验证该 channel 的必填配置（由 channel 包统一声明所需字段）
  const requiredKeys = CHANNEL_REQUIRED_CONFIG[channelType]
  const missingKeys = requiredKeys.filter(k => !config[k as keyof typeof config])
  if (missingKeys.length > 0) {
    console.log('')
    logError(`缺少 ${channelType} 配置: ${missingKeys.join(', ')}`)
    console.log('')
    console.log('  请用以下任一方式配置:')
    console.log('')
    console.log('  1. 全局配置:')
    missingKeys.forEach(k => {
      const flag = k.replace(/([A-Z])/g, '-$1').toLowerCase()
      console.log(`     ${colors.cyan(`pcr config set ${flag} <value>`)}`)
    })
    console.log('')
    console.log('  2. 当前目录创建 .env.pcr 文件')
    console.log('')
    process.exit(1)
  }

  // 检查 claude 安装（spawn 模式才需要）
  function checkClaudeInstallation(bin: string): boolean {
    try {
      const result = spawnSync(bin, ['--version'], {
        stdio: 'ignore',
        shell: true
      })
      return result.status === 0
    } catch {
      return false
    }
  }

  console.log('')
  logInfo('PocketRelay v0.1.0 启动中...')
  console.log('')

  if (executorMode === 'spawn') {
    logInfo('检查 Claude Code 安装...')
    if (!checkClaudeInstallation(claudeBin)) {
      logError(`未找到 claude 命令: ${claudeBin}`)
      console.log('  请先安装 Claude Code: https://docs.anthropic.com/claude-code')
      console.log('  或用 pcr config set claude-bin <path> 设置路径')
      console.log('')
      process.exit(1)
    }
    logSuccess('Claude Code 已就绪')
  }

  // 初始化组件（由 channel 包工厂函数统一创建，core 层无需感知具体实现）
  logInfo(`初始化 ${channelType} 连接...`)
  const channel = createChannel(channelType, config as unknown as Record<string, string>)
  const executorConfig: ExecutorConfig = {
    claudeBin,
    cwd: claudeCwd,
    timeoutMs
  }

  const executor =
    executorMode === 'acp'
      ? new ClaudeCodeAcpExecutor(executorConfig)
      : new ClaudeCodeExecutor(executorConfig)

  const daemon = new Daemon(channel, executor, claudeCwd)

  logInfo(`正在连接 ${channelType}...`)
  console.log('')

  await daemon.start()

  // daemon.start() 内部 await channel.connect()，连接就绪后才继续
  console.log('')
  logSuccess('PocketRelay 启动成功')
  console.log('')
  console.log(colors.bold(`  Node ID: ${colors.cyan(daemon.nodeId)}`))
  console.log('')
  console.log('  在 IM 中发送以下命令完成绑定:')
  console.log(colors.yellow(`    /bind ${daemon.nodeId}`))
  console.log('')
  console.log(`  工作目录: ${claudeCwd}`)
  console.log(`  执行器模式: ${executorMode}`)
  console.log('')

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('')
    logInfo('正在退出...')
    if (executor instanceof ClaudeCodeAcpExecutor) {
      await executor.dispose()
    }
    await channel.disconnect()
    logSuccess('再见!')
    process.exit(0)
  })

  process.on('uncaughtException', err => {
    logError(`未捕获异常: ${err.message}`)
    console.error(err.stack)
  })

  process.on('unhandledRejection', reason => {
    logError(`未处理 Promise 拒绝: ${String(reason)}`)
  })
}
