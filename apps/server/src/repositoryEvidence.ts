const repositoryEvidencePatterns = [
  /这是(?:一个|个)?什么(?:项目|工程)|这是什么(?:项目|工程)/i,
  /(?:介绍|解释|说明|分析|了解|查看)(?:一下)?(?:这个|当前|本)(?:项目|仓库|代码库|工程)/i,
  /(?:这个|当前|本)(?:项目|仓库|代码库|工程)(?:是|属于|用了?|有|包含|采用|做|主要|的?(?:结构|技术栈|功能|用途|类型))/i,
  /(?:项目|仓库|代码库|工程).{0,20}(?:是什么|做什么|技术栈|结构|功能|用途|类型)/i,
  /\bwhat (?:kind of )?(?:project|repo|repository|codebase) is (?:this|it)\b/i,
  /\b(?:describe|explain|analy[sz]e|inspect|understand) (?:this|the current) (?:project|repo|repository|codebase)\b/i,
  /\b(?:this|the current) (?:project|repo|repository|codebase).{0,30}(?:architecture|tech stack|purpose|features|structure|type|does)\b/i
];

/** 判断请求是否必须读取当前工作区，不能仅凭对话常识直接回答。 */
export function requiresRepositoryEvidence(userRequest: string) {
  const normalized = userRequest.trim();
  return repositoryEvidencePatterns.some((pattern) => pattern.test(normalized));
}
