import path from 'node:path'
import { existsSync } from 'node:fs'

/** Start only the explicitly configured portable installation. */
export function mountPortableOllama(ctx, root) {
  if (!root) return
  const warn = message => { try { ctx.logger.warn(`mnemos ollama: ${message}`) } catch {} }
  ctx.effect(() => {
    let handle
    let closing = false
    try {
      if (!path.isAbsolute(root)) throw new Error('ollamaPortableDir must be absolute')
      const executable = path.join(root, 'ollama.exe')
      const home = path.join(root, 'home')
      const models = path.join(root, 'models')
      if (![executable, home, models].every(existsSync)) throw new Error('portable executable, home, or models missing')
      const subprocess = ctx.get('subprocess')
      if (!subprocess) throw new Error('host subprocess service unavailable')
      // DSH subprocess handle owns the process range, including Ollama's inference runners.
      handle = subprocess.spawn({
        argv: [executable, 'serve'], cwd: root,
        env: { USERPROFILE: home, OLLAMA_MODELS: models, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_KEEP_ALIVE: '5m' },
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 8192 } },
        graceMs: 3000,
      })
      void handle.done.then(outcome => {
        if (!closing) warn(`service exited (${outcome.exitCode ?? outcome.signal ?? 'unknown'}); check port 11434`)
      }, error => {
        if (!closing) warn(`service failed (${error?.code || error?.name || 'Error'})`)
      })
    } catch (error) {
      warn(error?.message || 'could not start service')
    }
    return async () => {
      closing = true
      if (!handle) return
      try {
        await handle.terminate()
        await handle.waitForExit()
      } catch (error) {
        warn(`shutdown could not verify process exit (${error?.code || error?.name || 'Error'})`)
      }
    }
  }, 'Mnemos portable Ollama')
}
