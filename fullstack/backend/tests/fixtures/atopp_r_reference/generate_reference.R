# Independent R reference, generated from raw full 31-item built-in data.
# No external package polychoric estimates are used as expected values.
# Deterministic reference for two-stage polychoric EFA, without CDF subtraction.
args <- commandArgs(trailingOnly=TRUE); root <- args[[1]]
raw <- read.csv(file.path(root,'atopp-541x31.csv'),check.names=FALSE)
x <- as.matrix(raw[,!startsWith(names(raw),'__'),drop=FALSE])
q <- 3; p <- ncol(x); n <- nrow(x)
stopifnot(n==541,p==31,all(is.finite(x)),all(x>=1 & x<=5))
writeLines(capture.output(sessionInfo()),file.path(root,'R-session-info.txt'))
set.seed(19)
pearson <- cor(x)
ml <- factanal(covmat=pearson,n.obs=n,factors=q,rotation='none',
               control=list(nstart=3,lower=.005,opt=list(factr=1e3,pgtol=1e-8)))
ml_reproduced <- tcrossprod(unclass(ml$loadings))+diag(ml$uniquenesses)
ml_objective <- as.numeric(determinant(ml_reproduced,logarithm=TRUE)$modulus+
    sum(diag(solve(ml_reproduced,pearson)))-determinant(pearson,logarithm=TRUE)$modulus-p)
write.table(pearson,file.path(root,'atopp-pearson-R-correlation.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.table(ml$uniquenesses,file.path(root,'atopp-pearson-R-uniqueness.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.table(ml_reproduced,file.path(root,'atopp-pearson-R-reproduced.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.csv(data.frame(objective=ml_objective,statistic=unname(ml$STATISTIC),df=ml$dof,pValue=unname(ml$PVAL)),
          file.path(root,'atopp-pearson-R-metrics.csv'),row.names=FALSE)
message('Full 31-item Pearson ML reference complete')
th <- t(sapply(seq_len(p),function(j) qnorm(sapply(1:4,function(k)mean(x[,j]<=k)))))
r <- diag(p); diagnostics <- list()
for(a in seq_len(p-1)) for(b in (a+1):p) {
  counts <- table(factor(x[,a],levels=1:5),factor(x[,b],levels=1:5))
  er <- c(-Inf,th[a,],Inf);ec <- c(-Inf,th[b,],Inf)
  probability <- function(i,j,rho) {
    ss <- sqrt(1-rho*rho)
    integrate(function(z) {
      lo <- (ec[j]-rho*z)/ss;hi <- (ec[j+1]-rho*z)/ss
      diff <- ifelse(lo>0,pnorm(lo,lower.tail=FALSE)-pnorm(hi,lower.tail=FALSE),pnorm(hi)-pnorm(lo))
      dnorm(z)*diff
    },er[i],er[i+1],abs.tol=1e-12,rel.tol=1e-12,subdivisions=200L)$value
  }
  nll <- function(rho) {
    value <- 0
    for(i in 1:5)for(j in 1:5)if(counts[i,j]>0) {
      prob <- probability(i,j,rho)
      if(!is.finite(prob) || prob<=0)return(.Machine$double.xmax)
      value <- value-counts[i,j]*log(prob)
    }
    value
  }
  fit <- optimize(nll,c(-.9999,.9999),tol=1e-10)
  r[a,b] <- r[b,a] <- fit$minimum
  diagnostics[[length(diagnostics)+1]] <- data.frame(first=a,second=b,rho=fit$minimum,nll=fit$objective)
  if(length(diagnostics)%%50==0)message(length(diagnostics),'/465 pairs complete')
}
write.table(r,file.path(root,'atopp-adaptive-R-correlation.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.table(th,file.path(root,'atopp-adaptive-R-thresholds.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.csv(do.call(rbind,diagnostics),file.path(root,'atopp-adaptive-R-pairs.csv'),row.names=FALSE)
uls <- function(u) {
  a <- r-diag(u);ee <- eigen(a,symmetric=TRUE)
  l <- sweep(ee$vectors[,1:q,drop=FALSE],2,sqrt(pmax(ee$values[1:q],0)),'*')
  e <- a-tcrossprod(l)
  list(value=sum(e^2),gradient=-2*diag(e),loadings=l)
}
set.seed(19)
init <- pmin(pmax(1/diag(solve(r)),.005),1)
starts <- cbind(init,matrix(runif(2*p,.05,.95),nrow=p))
fits <- lapply(1:ncol(starts),function(j) optim(starts[,j],function(u)uls(u)$value,
               function(u)uls(u)$gradient,method='L-BFGS-B',lower=.005,upper=1,
               control=list(maxit=1000,factr=1e3,pgtol=1e-8)))
best <- fits[[which.min(sapply(fits,function(f)f$value))]]
uf <- uls(best$par);psi <- 1-rowSums(uf$loadings^2)
write.table(psi,file.path(root,'atopp-adaptive-R-uniqueness.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.table(tcrossprod(uf$loadings)+diag(psi),file.path(root,'atopp-adaptive-R-reproduced.csv'),sep=',',row.names=FALSE,col.names=FALSE)
write.csv(data.frame(objective=uf$value,convergence=best$convergence,maxRawGradient=max(abs(uf$gradient))),
          file.path(root,'atopp-adaptive-R-metrics.csv'),row.names=FALSE)
message('465 deterministic pairs and full-profile ULS complete')
