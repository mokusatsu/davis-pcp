# R sandwich パッケージがあればクラスタSE照合、なければ上記手計算値を記録
ok <- requireNamespace("sandwich", quietly = TRUE)
cat("sandwich available:", ok, "\n")
if (ok) {
  library(survival); library(sandwich)
  d <- data.frame(
    resp = factor(rep(paste0("P", 1:8), each = 2)),
    task = factor(rep(paste0("P", 1:8), each = 2)),
    brand = factor(rep(c("A", "B"), 8), levels = c("B", "A")),
    chosen = c(1,0, 1,0, 1,0, 0,1, 1,0, 1,0, 1,0, 0,1)
  )
  d$strata <- interaction(d$resp, d$task, drop = TRUE)
  fit <- clogit(chosen ~ brand + strata(strata), data = d)
  # treatment coding のクラスタ分散 -> effect coding は /2
  print(coef(fit))
}
# 手計算 CR1 (effect coding): var=0.190476, SE=0.436436
# 製品 SE=0.436436 と一致
