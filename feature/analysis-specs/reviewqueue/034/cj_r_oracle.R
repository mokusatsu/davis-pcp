# Feature 034 R照合: survival::clogit による条件付きロジット照合
# E2Eと同一の 8回答者x2択データ (3:1 選択)
library(survival)
d <- data.frame(
  resp = factor(rep(paste0("P", 1:8), each = 2)),
  task = factor(rep(paste0("P", 1:8), each = 2)),
  alt = rep(c("A1", "A2"), 8),
  brand = factor(rep(c("A", "B"), 8), levels = c("B", "A")),
  chosen = c(1,0, 1,0, 1,0, 0,1, 1,0, 1,0, 1,0, 0,1)
)
# 層=回答者×タスク (各回答者1タスク)
d$strata <- interaction(d$resp, d$task, drop = TRUE)
fit <- clogit(chosen ~ brand + strata(strata), data = d)
print(summary(fit))
cat("COEF:", coef(fit), "\n")
cat("SE:", sqrt(diag(vcov(fit))), "\n")
# 解析解 beta = ln(3)/2 の確認
cat("ANALYTIC:", log(3)/2, "\n")
