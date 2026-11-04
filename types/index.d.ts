export type LassoClip = {
  id: string
  /** the file's name, shown on the chip */
  name: string
  path: string
  /** 1 for an image */
  page: number
  kind: 'region' | 'text'
  text: string
  note?: string
  /** the clip's screenshot, a PNG */
  image?: string
}

export type LassoServer = { port: number; token: string }

export type LassoLang = 'zh' | 'en'

declare module 'claude-code' {
  interface PluginState {
    lasso: {
      clips: Shaped<LassoClip[]>
      server: LassoServer | null
      promptLang: LassoLang | null
    }
  }
}
