const MAX_LENGTH = 4000

/**
 * 将长文本切割为 QQ 单条消息允许的长度（4000字符）
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text]

  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + MAX_LENGTH))
    offset += MAX_LENGTH
  }
  return chunks
}

/**
 * 从 QQ 消息 content 字段提取纯文本
 * QQ 群消息中 @机器人 的格式为 <@!botId>，需要过滤掉
 */
export function extractText(content: string): string {
  return content
    .replace(/<@!?[^>]+>/g, '') // 去掉 @机器人 标记
    .trim()
}
