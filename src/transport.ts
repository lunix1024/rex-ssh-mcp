import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { SafeLogger } from './logger.js';

/** SDK 自己生成的参数错误也必须经过脱敏，避免未知参数名称被错误消息原样回显。 */
export class SafeStdioTransport extends StdioServerTransport {
  constructor(private readonly redactor: SafeLogger) { super(); }

  override send(message: JSONRPCMessage): Promise<void> {
    return super.send(sanitizeJsonRpcMessage(message, this.redactor));
  }
}

function sanitizeJsonRpcMessage(message: JSONRPCMessage, redactor: SafeLogger): JSONRPCMessage {
  if ('error' in message) {
    return { ...message, error: { ...message.error,
      message: cleanText(message.error.message, redactor),
      ...(message.error.data !== undefined ? { data: redactor.redactValue(message.error.data) } : {}),
    } };
  }
  if ('result' in message && Array.isArray(message.result.content)) {
    // 只处理工具返回通道；不修改 JSON-RPC ID、工具 schema 或协议版本等结构字段。
    const content = message.result.content.map((item: unknown) => {
      if (typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') {
        return { ...item, text: cleanText(item.text, redactor) };
      }
      return item;
    });
    return { ...message, result: { ...message.result, content,
      ...(message.result.structuredContent !== undefined ? { structuredContent: redactor.redactValue(message.result.structuredContent) } : {}),
    } };
  }
  return message;
}

function cleanText(value: string, redactor: SafeLogger): string {
  try {
    // 正常工具内容是 JSON：只脱敏值，避免短密码误改 stdout/exitCode 等 JSON 键名。
    return JSON.stringify(redactor.redactValue(JSON.parse(value) as unknown));
  } catch { /* SDK 校验错误是普通文本，继续使用文本脱敏。 */ }
  return redactor.redactText(value);
}
