import { getMiotService } from './service'
import { miotLog } from './log'

export { handleMiotRequest } from './handler'
export { getMiotService }

export const startMiotService = (): void => {
  try {
    getMiotService().start()
  } catch (err: any) {
    miotLog.error(`[MIoT] 启动失败: ${err?.message || err}`)
  }
}

export const stopMiotService = (): void => {
  try {
    getMiotService().shutdown()
  } catch (err: any) {
    miotLog.warn(`[MIoT] 停止失败: ${err?.message || err}`)
  }
}

process.once('exit', stopMiotService)
