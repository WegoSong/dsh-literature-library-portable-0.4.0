/** Public remediation metadata only. Raw provider credentials/headers are never copied here. */
export function classifyTaskFailure(error){
 const message=String(error?.message??error);
 if(/DSH.*账号|账号.*授权/iu.test(message))return {code:'dsh-account',label:'DSH 账号调用未完成',action:'检查 DSH 登录与额度',canResume:false};
 if(/版面|抽取|分区|ownership|coverage|layout-error|OCR/iu.test(message))return {code:'layout',label:'原文解析需要纠错',action:'检查问题页',canResume:false};
 if(/\b(?:401|403)\b|api\s*key|鉴权/iu.test(message))return {code:'authorization',label:'API 配置未通过',action:'检查 API 配置',canResume:false};
 if(/\b402\b|余额|balance/iu.test(message))return {code:'balance',label:'服务额度不足',action:'检查服务额度',canResume:false};
 if(/max.?tokens|截断|输出预算/iu.test(message))return {code:'truncated',label:'译文输出被截断',action:'调整预算后续传',canResume:true};
 if(/校验|placeholder|reordered|token-moved|完整性|恢复未通过/iu.test(message))return {code:'integrity',label:'部分内容需要恢复',action:'续传失败部分',canResume:true};
 if(/timeout|timed out|network|fetch|econn|socket|\b(?:429|5\d\d)\b/iu.test(message))return {code:'transport',label:'翻译连接中断',action:'续传',canResume:true};
 return {code:'unknown',label:'任务未完成',action:'查看诊断后续传',canResume:true};
}
