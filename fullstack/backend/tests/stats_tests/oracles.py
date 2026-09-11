"""Independent oracles. NEVER import app or obtain expected values from the SUT.

Arithmetic: Fraction / mpmath (60 decimal digits). Matrix survey calculation uses
integer Kronecker contrasts, not the application's residualized dummy matrix.
The R runner is a separate, stronger implementation-parity check.
"""
from fractions import Fraction as Q
from itertools import combinations
from math import comb, factorial, sqrt
import mpmath as mp
import numpy as np

mp.mp.dps = 60

def mq(x):
    return mp.mpf(str(x))

def q(x):
    return Q(str(x))

def mean_variance(xs):
    a = list(map(q, xs)); n = len(a)
    m = sum(a, Q(0))/n
    return float(m), float(sum((x-m)**2 for x in a)/(n-1))

def quantile7(xs, p):
    a = sorted(map(q,xs)); h = (len(a)-1)*q(p)
    j = h.numerator//h.denominator
    return float(a[j] if j == len(a)-1 else a[j]+(h-j)*(a[j+1]-a[j]))

def weighted_moments(xs, ws):
    x,w = list(map(q,xs)),list(map(q,ws))
    W=sum(w); W2=sum(v*v for v in w)
    mean=sum(a*b for a,b in zip(x,w))/W
    var=sum(b*(a-mean)**2 for a,b in zip(x,w))/(W-W2/W)
    return float(mean),float(var),float(W*W/W2)

def chi2_sf(x, df):
    return float(mp.gammainc(mq(df)/2,mq(x)/2,mp.inf,regularized=True))

def f_sf(x, d1, d2):
    if x == 0: return 1.0
    a,b=mq(d1)/2,mq(d2)/2
    z=mq(d2)/(mq(d2)+mq(d1)*mq(x))
    return float(mp.betainc(b,a,0,z,regularized=True))

def t_two_sided(t, df):
    v=mq(df)
    return float(mp.betainc(v/2,mp.mpf('0.5'),0,v/(v+mq(t)**2),regularized=True))

def welch(xs, ys, wx=None, wy=None):
    ma,va=mean_variance(xs); na=float(len(xs))
    mb,vb=mean_variance(ys); nb=float(len(ys))
    if wx is not None: ma,va,na=weighted_moments(xs,wx)
    if wy is not None: mb,vb,nb=weighted_moments(ys,wy)
    A,B=mq(va)/mq(na),mq(vb)/mq(nb)
    se=mp.sqrt(A+B); t=(mq(ma)-mq(mb))/se
    df=(A+B)**2/(A*A/(mq(na)-1)+B*B/(mq(nb)-1))
    return dict(statistic=float(t),df=float(df),p=t_two_sided(t,df),se=float(se),difference=ma-mb)

def welch_anova(groups):
    """Welch (1951), including its finite-sample F correction."""
    k=len(groups)
    ns=list(map(len,groups))
    mv=[mean_variance(a) for a in groups]
    ws=[mq(n)/mq(v) for n,(_,v) in zip(ns,mv)]
    W=sum(ws); mu=sum(w*mq(m) for w,(m,_) in zip(ws,mv))/W
    B=sum((1-w/W)**2/(n-1) for w,n in zip(ws,ns))
    A=sum(w*(mq(m)-mu)**2 for w,(m,_) in zip(ws,mv))/(k-1)
    F=A/(1+2*(k-2)*B/(k*k-1)); d1=k-1; d2=(k*k-1)/(3*B)
    return dict(statistic=float(F),df1=d1,df2=float(d2),p=f_sf(F,d1,d2))

def pearson(table):
    a=[[q(v) for v in row] for row in table]
    a=[row for row in a if sum(row)>0]
    if not a:return (None,None,None)
    cols=[j for j in range(len(a[0])) if sum(row[j] for row in a)>0]
    a=[[row[j] for j in cols] for row in a]
    r,c=len(a),len(cols); N=sum(map(sum,a))
    if r<2 or c<2:return (None,None,None)
    rt=list(map(sum,a)); ct=[sum(row[j] for row in a) for j in range(c)]
    statistic=sum((a[i][j]-rt[i]*ct[j]/N)**2/(rt[i]*ct[j]/N) for i in range(r) for j in range(c))
    return float(statistic),(r-1)*(c-1),float(mp.sqrt(mq(float(statistic/N))/min(r-1,c-1)))

def fisher_probability_ordered(table):
    """Conditional hypergeometric, two-sided probability ordering, exact rationals."""
    a,b=map(int,table[0]); c,d=map(int,table[1]); N=a+b+c+d
    r=a+b; col=a+c
    den=comb(N,r)
    prob=lambda x:Q(comb(col,x)*comb(N-col,r-x),den)
    observed=prob(a)
    return float(sum((prob(x) for x in range(max(0,r-(N-col)),min(r,col)+1) if prob(x)<=observed),Q(0)))

def bh(ps):
    """Definition-based suffix minimum; not production's running-min loop."""
    order=sorted(range(len(ps)),key=lambda i:ps[i]); m=len(ps); ans=[0.]*m
    for j,idx in enumerate(order):
        ans[idx]=float(min([Q(1)]+[q(ps[order[k]])*m/(k+1) for k in range(j,m)]))
    return ans

def cliff(a,b):
    return sum((x>y)-(x<y) for x in a for y in b)/(len(a)*len(b))

def kendall_tau_b(x,y):
    C=D=Tx=Ty=0
    for i,j in combinations(range(len(x)),2):
        dx=(x[i]>x[j])-(x[i]<x[j]); dy=(y[i]>y[j])-(y[i]<y[j])
        if dx==0 and dy==0:continue
        if dx==0:Tx+=1
        elif dy==0:Ty+=1
        elif dx==dy:C+=1
        else:D+=1
    den=sqrt((C+D+Tx)*(C+D+Ty))
    return (C-D)/den if den else None

def mann_whitney_exact(a,b):
    assert len(set(a+b))==len(a+b), 'This oracle is exact only without ties.'
    n,m=len(a),len(b); values=sorted(a+b)
    observed=sum(x>y for x in a for y in b)
    Us=[sum(i+1 for i in chosen)-n*(n+1)//2 for chosen in combinations(range(n+m),n)]
    p=min(1.,2*sum(u<=min(observed,n*m-observed) for u in Us)/len(Us))
    return observed,p

def survey_mean_covariance(X,w,strata=None,psu=None,fpc=None):
    X=[[mq(v) for v in row] for row in X]; w=list(map(mq,w)); n=len(w); p=len(X[0])
    strata=list(strata) if strata is not None else ['1']*n
    psu=list(psu) if psu is not None else list(range(n))
    W=sum(w); mean=[sum(w[i]*X[i][j] for i in range(n))/W for j in range(p)]
    z=[[w[i]*(X[i][j]-mean[j])/W for j in range(p)] for i in range(n)]
    V=mp.zeros(p)
    for h in dict.fromkeys(strata):
        indexes=[i for i in range(n) if strata[i]==h]
        units=list(dict.fromkeys(psu[i] for i in indexes)); m=len(units)
        if m<2:raise ValueError('Oracle refuses a non-certainty singleton stratum')
        totals=[mp.matrix([sum(z[i][j] for i in indexes if psu[i]==u) for j in range(p)]) for u in units]
        center=sum(totals,mp.zeros(p,1))/m
        factor=mq(m)/(m-1)
        if fpc is not None:
            N=mq(fpc[indexes[0]]); assert all(mq(fpc[i])==N for i in indexes)
            factor*=1-m/N
        for t in totals:V+=(t-center)*(t-center).T*factor
    return V

def rao_scott(row,col,w,strata=None,psu=None,fpc=None):
    """High precision formula oracle, NOT an R-produced golden value."""
    n=len(w); r=max(row)+1; c=max(col)+1; k=(r-1)*(c-1); p=r*c
    indicators=[[int(row[i]==a and col[i]==b) for a in range(r) for b in range(c)] for i in range(n)]
    weights=list(map(mq,w)); W=sum(weights)
    P=mp.matrix([sum(weights[i]*indicators[i][j] for i in range(n))/W for j in range(p)])
    assert min(P)>0, 'Positive-cell fixture required for inverse probability contrast oracle'
    C=mp.zeros(p,k)
    # Contrasts e_i-e_last tensor e_j-e_last. Orthogonal to all row/column main effects.
    for i in range(r-1):
        for j in range(c-1):
            z=i*(c-1)+j
            for a,b,sgn in [(i,j,1),(i,c-1,-1),(r-1,j,-1),(r-1,c-1,1)]:C[a*c+b,z]=sgn
    D=mp.diag([1/x for x in P])
    V=survey_mean_covariance(indicators,w,strata,psu,fpc)
    Delta=(C.T*D*C/n)**-1*(C.T*D*V*D*C)
    tr=sum(Delta[i,i] for i in range(k)); D2=Delta*Delta; tr2=sum(D2[i,i] for i in range(k))
    rt=[sum(P[i*c+j] for j in range(c)) for i in range(r)]
    ct=[sum(P[i*c+j] for i in range(r)) for j in range(c)]
    chi=n*sum((P[i*c+j]-rt[i]*ct[j])**2/(rt[i]*ct[j]) for i in range(r) for j in range(c))
    strata=list(strata) if strata is not None else ['1']*n
    psu=list(psu) if psu is not None else list(range(n))
    df=sum(len(set(psu[i] for i in range(n) if strata[i]==h))-1 for h in set(strata))
    F=chi/tr; d1=tr*tr/tr2; d2=d1*df
    return dict(statistic=float(F),df1=float(d1),df2=float(d2),p=f_sf(F,d1,d2))

def pooled_d(a,b):
    ma,va=mean_variance(a); mb,vb=mean_variance(b)
    pooled=((len(a)-1)*va+(len(b)-1)*vb)/(len(a)+len(b)-2)
    return (ma-mb)/sqrt(pooled)
