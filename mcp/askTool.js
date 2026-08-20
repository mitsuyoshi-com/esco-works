// AIがユーザーに「選択肢付きの質問」をするためのMCPツール。
// 呼ばれると renderer に選択肢を出し、ユーザーが選んだ答えをツール結果として返す。
// deps.ask(question, options) が Promise<string>（選ばれた回答）を返す。

async function createAskMcpServer(deps) {
  // SDKはESM専用のため動的importで読み込む
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  const askUser = tool(
    'ask_user',
    'ユーザーに選択肢を提示して回答を得る。方針・保存先・デザイン案など、ユーザーに決めてもらうべき分岐があるときに使う。自由記述より、まずこの選択肢での質問を優先する。',
    {
      question: z.string().describe('ユーザーへの質問文（1文、簡潔に）'),
      options: z
        .array(z.string())
        .min(2)
        .max(6)
        .describe('選んでもらう選択肢（2〜6個）。各選択肢は短い語句にする。')
    },
    async (args) => {
      const answer = await deps.ask(args.question, args.options || [])
      return { content: [{ type: 'text', text: `ユーザーの回答: ${answer}` }] }
    }
  )

  return createSdkMcpServer({
    name: 'ask',
    version: '1.0.0',
    tools: [askUser]
  })
}

module.exports = { createAskMcpServer }
