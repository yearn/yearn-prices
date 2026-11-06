const secrets = Object.entries(process.env)
  .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|URL|URI/.test(key) && value && value.length >= 8)
  .map(([, value]) => value as string)

export function clean(message: string): string {
  let result = message.replace(/https?:\/\/[^\s"'<>]+/g, '[redacted-url]')
  for (const secret of secrets) result = result.replaceAll(secret, '[redacted]')
  return result.slice(0, 4000)
}
