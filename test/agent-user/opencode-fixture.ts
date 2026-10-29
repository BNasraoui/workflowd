import { join } from "node:path"

export const fixturePassword = crypto.randomUUID()

export function fixtureEnvironment(home: string) {
  return {
    PATH: process.env.PATH!,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_SERVER_PASSWORD: fixturePassword,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }
}
