import { createHash, randomBytes } from 'node:crypto'

export const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex')

/**
 * 小米登录 clientSign = base64(sha1("nonce={nonce}&{ssecurity}"))
 */
export const computeClientSign = (nonce: string, ssecurity: string): string =>
  createHash('sha1').update(`nonce=${nonce}&${ssecurity}`, 'utf8').digest('base64')

/** 小米账号 deviceId：32 位十六进制字符串 */
export const generateDeviceId = (): string => randomBytes(16).toString('hex')

const REQUEST_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const generateRequestId = (): string => {
  const bytes = randomBytes(30)
  let result = 'app_ios_'
  for (let i = 0; i < bytes.length; i++) result += REQUEST_ID_CHARS[bytes[i] % REQUEST_ID_CHARS.length]
  return result
}

export const randomToken = (bytes = 24): string => randomBytes(bytes).toString('hex')

export const hashAccountKey = (value: string): string =>
  createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 16)
