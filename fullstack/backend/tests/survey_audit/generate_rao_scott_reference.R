# 補助oracle生成。今回の監査環境にはRがなく未実行。
# 依存の自動インストールはしない。stdoutの警告も含めて実行ログを保存すること。
if (!requireNamespace("survey", quietly=TRUE)) {
  stop("survey package is required; install it in your reference environment first")
}
args <- commandArgs(trailingOnly=TRUE)
out <- if (length(args)) args[[1]] else "rao_scott_reference.json"
options(survey.lonely.psu="fail")
base <- data.frame(
  a=factor(c("x","x","x","y","y","y")),
  b=factor(c("u","u","v","u","v","v")),
  w=rep(1,6)
)
wide <- data.frame(
  a=factor(c(rep("x",6),rep("y",6))),
  b=factor(rep(c("u","u","v","v","z","z"),2)),
  w=c(1,2,1,4,3,1,2,1,4,1,1,3)
)
cluster <- data.frame(
  a=factor(rep(c("x","x","y","y"),4)),
  b=factor(rep(c("u","v","u","v"),4)),
  w=c(1,2,2,6,1,3,4,4,2,1,1,8,3,2,6,1),
  s=factor(rep(c("S1","S2"),each=8)),
  p=rep(c("1","1","1","1","2","2","2","2"),2)
)
# セルに観測を残すよう、独立行の層化fixtureも固定する。
stratified <- cluster
cases <- list()
for (scale in c(1e-7,1,100)) {
  d <- base; d$w <- d$w*scale
  cases[[paste0("independent_2x2_scale_",format(scale,scientific=TRUE))]] <-
    survey::svydesign(ids=~1,weights=~w,data=d)
}
cases[["independent_2x3"]] <- survey::svydesign(ids=~1,weights=~w,data=wide)
cases[["stratified_independent_rows"]] <- survey::svydesign(ids=~1,strata=~s,weights=~w,data=stratified)
cases[["nested_psu_local_labels"]] <- survey::svydesign(ids=~p,strata=~s,weights=~w,data=cluster,nest=TRUE)
cluster$p <- paste(cluster$s,cluster$p,sep="-")
cases[["nested_psu_unique_labels"]] <- survey::svydesign(ids=~p,strata=~s,weights=~w,data=cluster,nest=TRUE)
number <- function(x) if (!length(x) || !is.finite(x[[1]])) "null" else sprintf("%.17g",as.numeric(x[[1]]))
quote_json <- function(x) {
  points <- utf8ToInt(enc2utf8(as.character(x)))
  escaped <- vapply(points, function(cp) {
    if (cp == 34) return("\\\"")
    if (cp == 92) return("\\\\")
    if (cp < 32) return(sprintf("\\u%04x", cp))
    intToUtf8(cp)
  }, character(1))
  paste0('"', paste(escaped, collapse=""), '"')
}
rows <- vapply(names(cases),function(name) {
  result <- tryCatch(survey::svychisq(~a+b,cases[[name]],statistic="F"),error=function(e)e)
  if (inherits(result,"error")) {
    return(paste0('{"case":',quote_json(name),',"status":"error","message":',quote_json(conditionMessage(result)),'}'))
  }
  paste0('{"case":',quote_json(name),',"status":"ok","F":',number(result$statistic),
         ',"numeratorDf":',number(result$parameter[1]),',"denominatorDf":',number(result$parameter[2]),
         ',"pValue":',number(result$p.value),'}')
},character(1))
text <- paste0('{"RVersion":',quote_json(R.version.string),',"surveyVersion":',
               quote_json(as.character(utils::packageVersion("survey"))),
               ',"lonelyPsuPolicy":"fail","cases":[',paste(rows,collapse=","),']}')
writeLines(text,out,useBytes=TRUE)
message("Wrote ",out)
