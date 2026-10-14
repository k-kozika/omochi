import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Serializes read/modify/write across processes; a live owner is never timed out. */
export async function withStateLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  const started = Date.now()
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: number | null = null
      try { owner = Number(await readFile(`${lock}/pid`, 'utf8')) } catch {}
      if (owner && Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0) } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            // Only one contender may reap a dead owner.
            try {
              await mkdir(`${lock}/reaping`)
              const current = Number(await readFile(`${lock}/pid`, 'utf8'))
              let dead = false
              try { process.kill(current, 0) } catch (check) { dead = (check as NodeJS.ErrnoException).code === 'ESRCH' }
              if (current === owner && dead) await rm(lock, { recursive: true, force: true })
              else await rm(`${lock}/reaping`, { recursive: true, force: true })
            } catch {}
            continue
          }
        }
      }
      if (Date.now() - started > 10_000) throw new Error(`state is locked: ${lock}`)
      await delay(10)
    }
  }
  try {
    await writeFile(`${lock}/pid`, String(process.pid), { mode: 0o600 })
    return await action()
  } finally { await rm(lock, { recursive: true, force: true }) }
}
