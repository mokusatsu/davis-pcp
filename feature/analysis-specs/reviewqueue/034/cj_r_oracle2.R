# クラスター頑健SE照合: sandwich クラスタ分散がなければ Cox モデル + cluster() で近似確認
# 製品 CR1 = G*/(G*-1) 補正の回答者クラスタ分散。R sandwich がなければ手計算で照合。
library(survival)
d <- data.frame(
  resp = factor(rep(paste0("P", 1:8), each = 2)),
  task = factor(rep(paste0("P", 1:8), each = 2)),
  brand = factor(rep(c("A", "B"), 8), levels = c("B", "A")),
  chosen = c(1,0, 1,0, 1,0, 0,1, 1,0, 1,0, 1,0, 0,1)
)
d$strata <- interaction(d$resp, d$task, drop = TRUE)
# effect coding 手計算: x=+1/-1, beta=ln(3)/2, score集約 -> CR1
beta <- log(3)/2
x <- ifelse(d$brand == "A", 1, -1)
# 各タスクの選択確率
pA <- exp(beta)/(exp(beta)+exp(-beta))
cat("effect beta:", beta, "\n")
# 回答者スコア: 選択 - 期待値
# A選択3件: score = 1-pA ... で CR1 を手計算
scores <- c(rep(1-pA, 3), -(1-pA), rep(1-pA, 3), -(1-pA))
# 8回答者のスコア (各1タスク)
meat <- sum(scores^2)
bread <- 1/sum(rep(2*pA*(1-pA), 8))
cr1 <- (8/7) * bread * meat * bread
cat("hand CR1 var:", cr1, " SE:", sqrt(cr1), "\n")
cat("product SE was 0.436436\n")
