"""Independent mathematical checks for the design, NOT production DAVIS kernels.

Inputs here are already-clean arrays. Application scope/codebook/MA/locking,
API integration, files, and user-interface logic are intentionally not replaced.
"""
from __future__ import annotations
import numpy as np
from numpy.typing import ArrayLike
from scipy import linalg, optimize, special


def weights(n: int, w: ArrayLike | None = None) -> np.ndarray:
    a = np.ones(n) if w is None else np.asarray(w, dtype=float)
    if a.shape != (n,) or not np.isfinite(a).all() or (a <= 0).any():
        raise ValueError("reference kernels require finite positive weights")
    return a


def svd_axes(A: ArrayLike):
    A = np.asarray(A, dtype=float)
    if A.ndim != 2 or not np.isfinite(A).all():
        raise ValueError("finite matrix required")
    u, s, vt = linalg.svd(A, full_matrices=False)
    tol = max(1e-12, np.finfo(float).eps * max(A.shape) * (s[0] if len(s) else 0))
    keep = s > tol
    u, s, v = u[:, keep], s[keep], vt[keep].T
    for k in range(len(s)):
        if v[np.argmax(np.abs(v[:, k])), k] < 0:
            u[:, k] *= -1
            v[:, k] *= -1
    return u, s, v


def ca(T: ArrayLike) -> dict:
    T = np.asarray(T, dtype=float)
    if T.ndim != 2 or not np.isfinite(T).all() or (T < 0).any() or T.sum() <= 0:
        raise ValueError("nonnegative nonempty finite table required")
    keep_r, keep_c = T.sum(1) > 0, T.sum(0) > 0
    T = T[np.ix_(keep_r, keep_c)]
    P = T / T.sum(); r = P.sum(1); c = P.sum(0)
    S = (P - np.outer(r, c)) / np.sqrt(np.outer(r, c))
    U, s, V = svd_axes(S)
    F = U * s / np.sqrt(r[:, None]); G = V * s / np.sqrt(c[:, None])
    for k in range(len(s)):
        if G[np.argmax(np.abs(G[:, k])), k] < 0:
            U[:, k] *= -1; V[:, k] *= -1; F[:, k] *= -1; G[:, k] *= -1
    return dict(P=P, S=S, r=r, c=c, U=U, V=V, s=s, eigenvalues=s*s,
                F=F, G=G, total=float(np.square(S).sum()), keep_r=keep_r, keep_c=keep_c)


def indicator(codes: ArrayLike) -> tuple[np.ndarray, list[slice]]:
    C = np.asarray(codes)
    if C.ndim != 2:
        raise ValueError("2D category codes required")
    blocks, slices, start = [], [], 0
    for j in range(C.shape[1]):
        cats = np.unique(C[:, j]); Z = (C[:, j, None] == cats[None, :]).astype(float)
        blocks.append(Z); slices.append(slice(start, start + len(cats))); start += len(cats)
    return np.column_stack(blocks), slices


def mca(Z: ArrayLike, m: int, w: ArrayLike | None = None) -> dict:
    Z = np.asarray(Z, dtype=float); a = weights(len(Z), w); a /= a.sum()
    if m < 2 or not np.allclose(Z.sum(1), m):
        raise ValueError("complete indicator row sum must equal m >= 2")
    p = a @ Z
    if (p <= 0).any():
        raise ValueError("remove zero-mass categories first")
    c = p / m; S = np.sqrt(a[:, None]) * (Z - p) / np.sqrt(m*p)
    U, s, V = svd_axes(S)
    F = U*s/np.sqrt(a[:, None]); G = V*s/np.sqrt(c[:, None])
    for k in range(len(s)):
        if G[np.argmax(np.abs(G[:, k])), k] < 0:
            U[:, k] *= -1; V[:, k] *= -1; F[:, k] *= -1; G[:, k] *= -1
    return dict(Z=Z, a=a, p=p, c=c, S=S, U=U, V=V, F=F, G=G, s=s,
                eigenvalues=s*s, total=float(np.square(S).sum()))


def benzecri(eigenvalues: ArrayLike, m: int):
    e = np.asarray(eigenvalues, dtype=float)
    adjusted = (m/(m-1))**2 * np.maximum(e - 1/m, 0)**2
    return adjusted, None if adjusted.sum() == 0 else adjusted / adjusted.sum()


def famd(numeric: ArrayLike, G: ArrayLike, blocks: list[slice], w: ArrayLike | None = None):
    Y = np.asarray(numeric, dtype=float); G = np.asarray(G, dtype=float)
    a = weights(len(Y), w); a /= a.sum()
    mean = a @ Y; scale = np.sqrt(a @ np.square(Y-mean)); p = a @ G
    if (scale <= 0).any() or (p <= 0).any():
        raise ValueError("nonconstant numeric variables and positive category masses required")
    X = np.column_stack(((Y-mean)/scale, (G-p)/np.sqrt(p)))
    U, s, V = svd_axes(np.sqrt(a[:, None])*X)
    F = X @ V; lam = s*s; P = Y.shape[1]
    bary = (G.T @ (a[:, None]*F)) / p[:, None]
    corr = V[:P] * s
    eta = np.stack([np.sum(p[b, None] * bary[b]**2, axis=0)/lam for b in blocks])
    return dict(X=X, a=a, mean=mean, scale=scale, p=p, U=U, V=V, s=s,
                F=F, eigenvalues=lam, total=float(np.sum(a[:, None]*X**2)),
                bary=bary, corr=corr, eta=eta, contributions=V*V)


def ols(X: ArrayLike, y: ArrayLike, w: ArrayLike | None = None, covariance="hc3"):
    X=np.asarray(X,dtype=float); y=np.asarray(y,dtype=float); f=weights(len(y),w)
    Xw=np.sqrt(f[:,None])*X; yw=np.sqrt(f)*y
    beta, _, rank, _=linalg.lstsq(Xw,yw,lapack_driver="gelsd")
    if rank != X.shape[1]: raise ValueError("rank deficient")
    _, s, vt=linalg.svd(Xw,full_matrices=False); bread=(vt.T/(s*s))@vt
    residual=y-X@beta; h=np.einsum('ij,jk,ik->i',X,bread,X); sse=np.dot(f,residual**2)
    if covariance=="classical": cov=sse/(f.sum()-X.shape[1])*bread
    elif covariance=="hc3":
        if (h >= 1-1e-12).any(): raise ValueError("HC3 leverage one")
        meat=X.T@((f*residual**2/(1-h)**2)[:,None]*X);cov=bread@meat@bread
    else: raise ValueError("reference covariance must be classical or hc3")
    return dict(beta=beta,cov=cov,bread=bread,residual=residual,h=h,sse=sse)


def survey_meat(scores: ArrayLike, strata: ArrayLike, psu: ArrayLike, fpc: dict | None = None):
    scores=np.asarray(scores,dtype=float); strata=np.asarray(strata); psu=np.asarray(psu)
    meat=np.zeros((scores.shape[1],scores.shape[1])); df=0
    for h in np.unique(strata):
        mask=strata==h; groups=np.unique(psu[mask])
        totals=np.stack([scores[mask & (psu==g)].sum(0) for g in groups]); m=len(groups)
        M=None if fpc is None else fpc[h]
        if M is not None and M < m: raise ValueError("FPC below sampled PSU count")
        if m==1:
            if M==1: continue
            raise ValueError("singleton PSU without certainty")
        centered=totals-totals.mean(0); correction=1 if M is None else 1-m/M
        meat+=correction*m/(m-1)*(centered.T@centered);df+=m-1
    return meat,df


def fa_profile(psi: ArrayLike, R: ArrayLike, q: int):
    psi=np.asarray(psi,dtype=float); R=np.asarray(R,dtype=float)
    d,E=linalg.eigh(R/np.sqrt(np.outer(psi,psi))); order=np.argsort(d)[::-1]
    d,E=d[order],E[:,order]
    L=np.sqrt(psi[:,None])*E[:,:q]*np.sqrt(np.maximum(d[:q]-1,0))
    Sigma=L@L.T+np.diag(psi); A=linalg.solve(Sigma,np.eye(len(psi)),assume_a='pos')
    value=np.linalg.slogdet(Sigma)[1]+np.trace(A@R)-np.linalg.slogdet(R)[1]-len(psi)
    gradient=np.diag(A-A@R@A)
    return float(value),gradient,L,Sigma


def ml_factor(R: ArrayLike,q:int,seed=42,n_starts=5):
    R=np.asarray(R,dtype=float);p=len(R);lower=.005
    invR=linalg.solve(R,np.eye(p),assume_a='pos')
    start=np.clip((1-.5*q/p)/np.diag(invR),lower,1)
    rng=np.random.default_rng(seed); starts=[start]+[rng.uniform(.05,.95,p) for _ in range(n_starts-1)]
    candidates=[]
    for initial in starts:
        fun=lambda psi: fa_profile(psi,R,q)[:2]
        fit=optimize.minimize(fun,initial,jac=True,method='L-BFGS-B',bounds=[(lower,1)]*p,
                              options={'ftol':1e-12,'gtol':1e-7,'maxiter':2000,'maxls':50})
        value,grad,L,Sigma=fa_profile(fit.x,R,q)
        pg=grad.copy();pg[(fit.x<=lower+1e-9)&(grad>0)]=0;pg[(fit.x>=1-1e-9)&(grad<0)]=0
        if fit.success and np.max(np.abs(pg))<=1e-5:
            candidates.append(dict(psi=fit.x,L=L,Sigma=Sigma,objective=value,success=True,
                                   projected_gradient=float(np.max(np.abs(pg)))))
    if not candidates: raise RuntimeError("no accepted ML start")
    return min(candidates,key=lambda r:r['objective'])


def varimax(L: ArrayLike):
    L=np.asarray(L,dtype=float); h=np.linalg.norm(L,axis=1)
    B=np.divide(L,h[:,None],out=np.zeros_like(L),where=h[:,None]>0)
    T=np.eye(L.shape[1]);old=None
    for iteration in range(500):
        lam=B@T; C=B.T@(lam**3-lam@np.diag(np.sum(lam**2,axis=0))/len(B))
        U,s,Vt=linalg.svd(C,full_matrices=False);T=U@Vt;obj=s.sum()
        if old is not None and abs(obj-old)<=1e-8*max(1,abs(old)):
            return (B@T)*h[:,None],T
        old=obj
    raise RuntimeError("varimax nonconvergence")


def promax(L: ArrayLike):
    Lv,Tv=varimax(L);target=np.sign(Lv)*np.abs(Lv)**4
    B,_,rank,_=linalg.lstsq(Lv,target)
    if rank != Lv.shape[1]: raise ValueError("promax rank deficient")
    Phi0=linalg.solve(B.T@B,np.eye(B.shape[1]),assume_a='pos')
    scales=np.sqrt(np.diag(Phi0)); T=B@np.diag(scales)
    Phi=Phi0/np.outer(scales,scales);pattern=Lv@T
    return pattern,Phi,Tv@T


def choice_objective(beta: ArrayLike, stages: list[tuple[np.ndarray,int,int]], w: ArrayLike):
    """Stage tuple: (alternative design, chosen position, respondent index)."""
    beta=np.asarray(beta);w=np.asarray(w); p=len(beta)
    nll=0.;score=np.zeros(p);H=np.zeros((p,p));cluster=np.zeros((len(w),p))
    for X,chosen,r in stages:
        logits=X@beta;logp=logits-special.logsumexp(logits);prob=np.exp(logp)
        u=X[chosen]-prob@X
        hs=X.T@(np.diag(prob)-np.outer(prob,prob))@X
        nll-=w[r]*logp[chosen];score+=w[r]*u;H+=w[r]*hs;cluster[r]+=u
    return float(nll),-score,H,cluster


def separation(stages: list[tuple[np.ndarray,int,int]]):
    D=np.vstack([X[chosen]-X[j] for X,chosen,_ in stages for j in range(len(X)) if j!=chosen])
    scale=np.sqrt(np.mean(D*D,axis=0))
    if (scale==0).any(): raise ValueError("nonidentifiable constant design")
    D=D/scale
    result=optimize.linprog(-D.sum(0),A_ub=-D,b_ub=np.zeros(len(D)),
                            bounds=[(-1,1)]*D.shape[1],method='highs')
    if not result.success: raise RuntimeError("LP separation check failed")
    return -result.fun > 1e-8


def fit_choice(stages: list[tuple[np.ndarray,int,int]], w: ArrayLike):
    w=np.asarray(w,dtype=float);p=stages[0][0].shape[1]
    if separation(stages): raise ValueError("separation")
    obj=lambda b: choice_objective(b,stages,w)[:2]
    fit=optimize.minimize(obj,np.zeros(p),jac=True,method='BFGS',options={'gtol':1e-9,'maxiter':1000})
    val,grad,H,U=choice_objective(fit.x,stages,w)
    if np.max(np.abs(grad))/w.sum()>1e-6: raise RuntimeError("conditional logit nonconvergence")
    bread=linalg.solve(H,np.eye(p),assume_a='pos')
    G=w.sum(); meat=U.T@(w[:,None]*U);cov=G/(G-1)*bread@meat@bread
    return dict(beta=fit.x,nll=val,H=H,cluster=U,cov=cov,model_cov=bread)
