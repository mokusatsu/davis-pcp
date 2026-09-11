#!/usr/bin/env python3
"""Optional third-implementation self-check (statsmodels required, no app import)."""
from pathlib import Path
import json, sys, importlib.metadata
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from stats_tests.oracles import welch_anova
from statsmodels.stats.oneway import anova_oneway
GROUPS=[
 [[1,2,3,4,5],[4,5,6,7,8],[0,10,20,30,40,50,60]],
 [[2,3,4,5],[0,20,40,60,80,100],[7,8,9,10,11,12,13]],
 [[1,3,4,6,7],[3,4,8,9,14,20],[1,11,21,31,41,51,61,71]],
]
out=[]
for groups in GROUPS:
    ours=welch_anova(groups)
    ref=anova_oneway([np.array(g,dtype=float) for g in groups],use_var='unequal',welch_correction=True)
    other=dict(statistic=float(ref.statistic),df1=float(ref.df_num),df2=float(ref.df_denom),p=float(ref.pvalue))
    for key in ours:
        if not np.isclose(ours[key],other[key],rtol=1e-11,atol=1e-14):
            raise AssertionError((key,ours,other))
    out.append({'groups':groups,'independent_formula':ours,'statsmodels':other,'matched':True})
print(json.dumps({'statsmodels_version':importlib.metadata.version('statsmodels'),'cases':out},indent=2))
