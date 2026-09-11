#!/usr/bin/env Rscript
# Independent reference runner. No DAVIS imports, no production-generated expected values.
# Usage: Rscript generate_R_reference.R survey_synthetic.csv OUTPUT_DIRECTORY
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 2L) stop('Expected input CSV and output directory')
if (!requireNamespace('survey', quietly=TRUE)) stop('R package survey is required; do not skip parity')
options(digits=17, survey.lonely.psu='fail', survey.adjust.domain.lonely=FALSE)
dir.create(args[2],recursive=TRUE,showWarnings=FALSE)
d <- read.csv(args[1],stringsAsFactors=FALSE)
d$r <- factor(d$row,levels=0:1); d$c <- factor(d$col,levels=0:2)
rows <- list(); covrows <- list(); n <- 0L
for (kind in c('independent','cluster','stratified','fpc')) {
 for (scale in c(0.001,1,1000)) {
  work <- d; work$weight <- work$weight * scale
  design <- switch(kind,
   independent=survey::svydesign(ids=~1,weights=~weight,data=work),
   cluster=survey::svydesign(ids=~psu,weights=~weight,data=work),
   stratified=survey::svydesign(ids=~psu,strata=~stratum,weights=~weight,data=work),
   fpc=survey::svydesign(ids=~psu,strata=~stratum,weights=~weight,fpc=~fpc,data=work))
  result <- survey::svychisq(~r+c,design,statistic='F')
  m <- survey::svymean(~x+y,design)
  v <- stats::vcov(m)
  n <- n+1L
  rows[[n]] <- data.frame(kind=kind,scale=scale,F=unname(result$statistic),
       ndf=unname(result$parameter[1]),ddf=unname(result$parameter[2]),
       p=result$p.value,design_df=survey::degf(design))
  covrows[[n]] <- data.frame(kind=kind,scale=scale,xx=v[1,1],xy=v[1,2],yy=v[2,2])
 }
}
write_precise <- function(x,path) {
 for (j in seq_along(x)) if (is.numeric(x[[j]])) x[[j]] <- format(x[[j]],digits=17,scientific=TRUE,trim=TRUE)
 write.table(x,file=path,sep='\t',row.names=FALSE,quote=FALSE,na='NA')
}
write_precise(do.call(rbind,rows),file.path(args[2],'survey.tsv'))
write_precise(do.call(rbind,covrows),file.path(args[2],'covariance.tsv'))
groups <- list(c(1,2,3,4,5),c(4,5,6,7,8),c(0,10,20,30,40,50,60))
v <- unlist(groups); g <- factor(rep(seq_along(groups),lengths(groups)))
w <- oneway.test(v~g,var.equal=FALSE)
write_precise(data.frame(F=unname(w$statistic),ndf=w$parameter[1],ddf=w$parameter[2],p=w$p.value),file.path(args[2],'welch.tsv'))
p <- c(.01,.04,.03,.002,.5,0,1,.05,.05)
write_precise(data.frame(p=p,q=p.adjust(p,method='BH')),file.path(args[2],'bh.tsv'))
capture.output(sessionInfo(),file=file.path(args[2],'sessionInfo.txt'))
writeLines(c(paste('R',R.version.string),paste('survey',as.character(packageVersion('survey')))),file.path(args[2],'versions.txt'))
