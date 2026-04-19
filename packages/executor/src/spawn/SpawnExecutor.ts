import { spawn, type ChildProcess } from 'node:child_process'

export interface SpawnOptions {
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
}

export interface SpawnResult {
  exitCode: number | null
  fullOutput: string
  durationMs: number
  timedOut: boolean
}

export interface SpawnChunk {
  type: 'stdout' | 'stderr'
  data: string
}

/**
 * 通用的子进程执行器：可以执行任意命令，支持流式输出和超时取消。
 * CLI 类 Agent（ClaudeCodeExecutor 等）基于此类实现，避免重复写 spawn 逻辑。
 */
export class SpawnExecutor {
  private activeProcesses = new Map<string, ChildProcess>()

  /**
   * 执行命令
   * @param taskId 任务 ID（用于 cancel）
   * @param options 命令配置
   * @param onChunk 流式输出回调
   */
  async execute(
    taskId: string,
    options: SpawnOptions,
    onChunk: (chunk: SpawnChunk) => void
  ): Promise<SpawnResult> {
    const startTime = Date.now()
    let fullOutput = ''
    let timedOut = false

    const child = spawn(options.command, options.args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 下 spawn 不走 shell，找不到 PATH 里的 .cmd 文件，需要开启 shell
      shell: process.platform === 'win32'
    })

    this.activeProcesses.set(taskId, child)

    const timeoutHandle = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          this.cancel(taskId)
        }, options.timeoutMs)
      : null

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')

    child.stdout.on('data', (data: string) => {
      fullOutput += data
      onChunk({ type: 'stdout', data })
    })

    child.stderr.on('data', (data: string) => {
      fullOutput += data
      onChunk({ type: 'stderr', data })
    })

    const exitCode = await new Promise<number | null>(resolve => {
      child.on('close', code => resolve(code))
      child.on('error', err => {
        fullOutput += `\n[spawn error] ${err.message}`
        resolve(null)
      })
    })

    if (timeoutHandle) clearTimeout(timeoutHandle)
    this.activeProcesses.delete(taskId)

    return {
      exitCode,
      fullOutput,
      durationMs: Date.now() - startTime,
      timedOut
    }
  }

  /** 发送 SIGTERM，3 秒后若进程仍存在则强制 SIGKILL */
  cancel(taskId: string): void {
    const child = this.activeProcesses.get(taskId)
    if (!child) return

    child.kill('SIGTERM')

    setTimeout(() => {
      if (this.activeProcesses.has(taskId)) {
        child.kill('SIGKILL')
      }
    }, 3000)
  }
}
