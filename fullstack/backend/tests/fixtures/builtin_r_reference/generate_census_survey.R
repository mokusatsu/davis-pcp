args <- commandArgs(trailingOnly=TRUE)
root <- args[[1]]
suppressPackageStartupMessages(library(survey))
census <- read.csv(file.path(root,'census-kdd-adult600.csv'),check.names=FALSE)
census$worker_class <- factor(census$worker_class)
census$year <- factor(census$year)
design <- svydesign(ids=~1,weights=~MARSUPWT,data=census)
mean <- svymean(~weeks_worked,design,na.rm=TRUE)
result <- svychisq(~worker_class+year,design,statistic='F')
reference <- data.frame(RVersion=as.character(getRversion()),surveyVersion=as.character(packageVersion('survey')),
                        weightedMean=as.numeric(coef(mean)),weightedMeanSE=as.numeric(SE(mean)),
                        F=as.numeric(result$statistic),numeratorDf=as.numeric(result$parameter[1]),
                        denominatorDf=as.numeric(result$parameter[2]),pValue=result$p.value,
                        designDf=degf(design))
write.csv(reference,file.path(root,'census-survey-R-reference.csv'),row.names=FALSE)
print(reference)
