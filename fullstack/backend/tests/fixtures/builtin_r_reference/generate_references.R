# R oracles use raw imported built-in observations and explicit formulas.
args <- commandArgs(trailingOnly=TRUE)
root <- args[[1]]
writeLines(capture.output(sessionInfo()), file.path(root,'R-session-info.txt'))
write_matrix <- function(x,name) write.table(as.matrix(x),file.path(root,name),sep=',',row.names=FALSE,col.names=FALSE)
write_metrics <- function(x,name) write.csv(as.data.frame(x),file.path(root,name),row.names=FALSE)
set.seed(19)
for (sample in c('edss-efa-613x13','edss-cfa-646x13')) {
  d <- read.csv(file.path(root,paste0(sample,'.csv')),check.names=FALSE)
  x <- as.matrix(d[,!startsWith(names(d),'__'),drop=FALSE])
  stopifnot(ncol(x)==13,all(is.finite(x)),all(x>=1 & x<=5))
  r <- cor(x)
  f <- factanal(covmat=r,n.obs=nrow(x),factors=3,rotation='none',
                control=list(nstart=3,lower=.005,opt=list(factr=1e3,pgtol=1e-8)))
  l <- unclass(f$loadings)
  sigma <- tcrossprod(l)+diag(f$uniquenesses)
  objective <- as.numeric(determinant(sigma,logarithm=TRUE)$modulus + sum(diag(solve(sigma,r))) - determinant(r,logarithm=TRUE)$modulus - ncol(r))
  write_matrix(r,paste0(sample,'-pearson-R-correlation.csv'))
  write_matrix(f$uniquenesses,paste0(sample,'-pearson-R-uniqueness.csv'))
  write_matrix(sigma,paste0(sample,'-pearson-R-reproduced.csv'))
  write_metrics(list(objective=objective,statistic=unname(f$STATISTIC),df=f$dof,pValue=unname(f$PVAL)),paste0(sample,'-pearson-R-metrics.csv'))
  message(sample,' factanal complete')
  pc <- psych::polychoric(x,global=TRUE,correct=0,smooth=FALSE,progress=FALSE)
  pr <- pc$rho
  write_matrix(pr,paste0(sample,'-polychoric-R-correlation.csv'))
  write_matrix(pc$tau,paste0(sample,'-polychoric-R-thresholds.csv'))
  # Explicit full ULS profile matches the application's stated objective.
  # It is separate from psych::fa's MINRES residual/objective conventions.
  uls <- function(u,r,q=3) {
    a <- r-diag(u); ee <- eigen(a,symmetric=TRUE)
    l <- sweep(ee$vectors[,seq_len(q),drop=FALSE],2,sqrt(pmax(ee$values[seq_len(q)],0)),'*')
    residual <- a-tcrossprod(l)
    list(value=sum(residual^2),gradient=-2*diag(residual),loadings=l)
  }
  init <- pmin(pmax(1/diag(solve(pr)),.005),1)
  starts <- cbind(init,matrix(runif(26,.05,.95),nrow=13))
  fits <- lapply(seq_len(ncol(starts)),function(j) optim(starts[,j],function(u)uls(u,pr)$value,
        function(u)uls(u,pr)$gradient,method='L-BFGS-B',lower=.005,upper=1,
        control=list(maxit=1000,factr=1e3,pgtol=1e-8)))
  best <- fits[[which.min(sapply(fits,function(f)f$value))]]
  uf <- uls(best$par,pr); psi <- 1-rowSums(uf$loadings^2)
  write_matrix(best$par,paste0(sample,'-polychoric-R-optimizer-diagonal.csv'))
  write_matrix(psi,paste0(sample,'-polychoric-R-uniqueness.csv'))
  write_matrix(tcrossprod(uf$loadings)+diag(psi),paste0(sample,'-polychoric-R-reproduced.csv'))
  write_metrics(list(objective=uf$value,convergence=best$convergence,
                    maxRawGradient=max(abs(uf$gradient))),paste0(sample,'-polychoric-R-metrics.csv'))
  # Package comparison is supplementary, not an assumption that objective IDs match.
  pf <- psych::fa(pr,nfactors=3,n.obs=nrow(x),rotate='none',fm='minres',max.iter=1000,smooth=FALSE)
  write_matrix(tcrossprod(unclass(pf$loadings))+diag(pf$uniquenesses),paste0(sample,'-polychoric-psych-minres-reproduced.csv'))
  message(sample,' polychoric + full ULS + psych MINRES complete')
}
# Census descriptive masses: do not pretend these prove design-based inference.
census <- read.csv(file.path(root,'census-kdd-adult600.csv'),check.names=FALSE)
w <- census$MARSUPWT;valid <- !is.na(census$weeks_worked)
write_metrics(list(weightedMean=weighted.mean(census$weeks_worked[valid],w[valid]),
                   weightedN=sum(w[valid]),kishEffectiveN=sum(w)^2/sum(w^2)), 'census-R-summary.csv')
good <- !(census$migration_msa %in% c('?','Not in universe'))
mass <- tapply(w[good],census$migration_msa[good],sum)
write.csv(data.frame(code=names(mass),mass=as.numeric(mass),pct=100*as.numeric(mass)/sum(mass)),file.path(root,'census-R-masses.csv'),row.names=FALSE)
# Conditional logit: independent raw-code effect matrix, task likelihood, and
# respondent-cluster CR1 covariance. No pooled-row logistic regression.
d <- read.csv(file.path(root,'siechnice-cbc96.csv'),check.names=FALSE,colClasses='character')
levels <- read.csv(file.path(root,'choice-levels.csv'),colClasses=c('character','character','integer'))
X <- matrix(0,nrow(d),0)
for (a in unique(levels$attribute)) {
  lev <- levels[levels$attribute==a,];ref <- lev$code[lev$reference==1]
  block <- sapply(lev$code[lev$reference==0],function(code) as.numeric(d[[a]]==code)-as.numeric(d[[a]]==ref))
  block[d$status_quo=='1',] <- 0
  stopifnot(!anyNA(block))
  X <- cbind(X,block)
}
X <- cbind(X,as.numeric(d$status_quo))
y <- as.numeric(d$wybor)
g <- paste(d$respondent_id,d$zadanie,sep=':')
indices <- do.call(rbind,split(seq_len(nrow(d)),g))
stopifnot(ncol(indices)==3,nrow(indices)==1152,ncol(X)==17)
calculate <- function(beta) {
  util <- drop(X %*% beta);u <- matrix(util[indices],nrow=nrow(indices))
  maxima <- apply(u,1,max);ep <- exp(u-maxima);P <- ep/rowSums(ep)
  prob <- numeric(length(y));prob[as.vector(indices)] <- as.vector(P)
  list(value=sum(log(rowSums(ep))+maxima)-sum(y*util),gradient=-drop(crossprod(X,y-prob)),prob=prob)
}
fit <- optim(rep(0,ncol(X)),function(b)calculate(b)$value,function(b)calculate(b)$gradient,
             method='BFGS',control=list(maxit=1000,reltol=1e-12))
beta <- fit$par
# Newton solve also confirms the independent likelihood gradient is near zero.
for (iteration in seq_len(8)) {
  calc <- calculate(beta);means <- rowsum(X*calc$prob,g,reorder=FALSE)
  H <- crossprod(X,X*calc$prob)-crossprod(means)
  if(max(abs(calc$gradient)) < 1e-9) break
  beta <- beta-solve(H,calc$gradient)
}
calc <- calculate(beta);means <- rowsum(X*calc$prob,g,reorder=FALSE)
H <- crossprod(X,X*calc$prob)-crossprod(means);B <- solve(H)
scores <- rowsum(X*(y-calc$prob),d$respondent_id,reorder=FALSE);G <- nrow(scores)
covariance <- (G/(G-1))*B %*% crossprod(scores) %*% B
write_matrix(beta,'siechnice-R-beta.csv');write_matrix(covariance,'siechnice-R-covariance.csv')
write_matrix(X,'siechnice-R-design.csv')
write.csv(data.frame(rowId=d[['__rowId__']],probability=calc$prob),file.path(root,'siechnice-R-probabilities.csv'),row.names=FALSE)
write_metrics(list(logLikelihood=-calc$value,nullLogLikelihood=-1152*log(3),
                   respondents=G,tasks=1152,parameters=ncol(X),scoreInfNorm=max(abs(calc$gradient)),
                   referenceDf=G-1,convergence=fit$convergence),'siechnice-R-metrics.csv')
message('Siechnice full conditional-logit likelihood, coefficients, probabilities, respondent-cluster covariance complete')
