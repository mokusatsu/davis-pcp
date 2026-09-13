"""Generate redistributable synthetic fixtures and design reference values."""
from pathlib import Path
import csv,json
import numpy as np
from scipy import linalg
from reference_kernels import ca,indicator,mca,famd,ols,ml_factor,fit_choice
ROOT=Path(__file__).resolve().parents[1]
F=ROOT/'fixtures';F.mkdir(exist_ok=True)
def save_csv(name,header,rows):
    with (F/name).open('w',encoding='utf-8',newline='') as f:
        writer=csv.writer(f);writer.writerow(header);writer.writerows(rows)
def clean(x):
    if isinstance(x,np.ndarray):return x.tolist()
    if isinstance(x,np.generic):return x.item()
    if isinstance(x,dict):return {k:clean(v) for k,v in x.items()}
    if isinstance(x,list):return [clean(v) for v in x]
    return x
rng=np.random.default_rng(20260912)
T=np.array([[30,10],[10,30]])
save_csv('ca_2x2.csv',['row_category','C1','C2'],[['R1',30,10],['R2',10,30]])
n=24;cats=np.column_stack((np.arange(n)%2,np.arange(n)%3,rng.integers(0,3,n)))
Y=np.column_stack((35+5*cats[:,0]+2*cats[:,1]+rng.normal(0,2,n),3+.3*cats[:,2]+rng.normal(0,.25,n)))
f=np.tile([1,2,3,2],6)
save_csv('mixed_survey.csv',['__rowId__','q1','q2','q3','age','satisfaction','frequency'],
         [[f'r{i+1}',*cats[i],*Y[i],int(f[i])] for i in range(n)])
Z,blocks=indicator(cats);fm_G,fm_blocks=indicator(cats[:,:2])
X=np.column_stack((np.ones(10),np.arange(10)/3,[0,1,0,1,1,0,0,1,0,1]))
y=X@np.array([2.,1.5,-.7])+np.array([.2,-.4,.1,.3,-.2,.4,-.3,.1,-.2,.2])
f_lr=np.array([1,2,1,3,2,1,2,3,1,2])
save_csv('linear_regression.csv',['__rowId__','x','group_B','y','frequency'],
         [[f'lr{i+1}',X[i,1],int(X[i,2]),y[i],int(f_lr[i])] for i in range(10)])
L=np.array([[.8,.1],[.7,.2],[.65,.1],[.1,.8],[.2,.7],[.05,.75]])
psi=1-np.sum(L*L,axis=1);R=L@L.T+np.diag(psi)
raw=rng.normal(size=(80,6));raw-=raw.mean(0);Q,_=linalg.qr(raw,mode='economic')
FA=Q@linalg.cholesky(R,lower=True).T*np.sqrt(79)
save_csv('factor_exact_correlation.csv',['__rowId__']+[f'q{i+1}' for i in range(6)],
         [[f'fa{i+1}',*FA[i]] for i in range(80)])
save_csv('factor_expected_correlation.csv',[f'q{i+1}' for i in range(6)],R)
stages=[];cjrows=[]
for i in range(4):
    chosen=0 if i<3 else 1; xx=np.array([[1.],[-1.]])
    stages.append((xx,chosen,i))
    for j in range(2):cjrows.append([f'cj{i+1}_{j+1}',f'P{i+1}','T1',f'A{j+1}','A' if j==0 else 'B',int(j==chosen)])
save_csv('conjoint_choice_analytic.csv',['__rowId__','respondent_id','task_id','alternative_id','brand','chosen'],cjrows)
ratingrows=[]
for i in range(8):
    for t,(brand,price) in enumerate([(b,p) for b in ('A','B') for p in (100,200,300)]):
        rating=5+.15*i+(.6 if brand=='A' else -.6)-.004*(price-200)+rng.normal(0,.12)
        ratingrows.append([f'rt{i+1}_{t+1}',f'R{i+1}',f'T{t+1}','A1',brand,price,rating])
save_csv('conjoint_ratings_template.csv',['__rowId__','respondent_id','task_id','alternative_id','brand','price','rating'],ratingrows)
from itertools import permutations
rankrows=[]
for i,perm in enumerate(permutations(range(3))):
    for a in range(3):rankrows.append([f'rk{i+1}_{a+1}',f'R{i+1}','T1',f'A{a+1}',chr(65+a),perm.index(a)+1])
save_csv('conjoint_ranking_template.csv',['__rowId__','respondent_id','task_id','alternative_id','brand','rank'],rankrows)
fa_result=ml_factor(R,2)
result={
'provenance':{'kind':'synthetic','seed':20260912,'notApplicationOutput':True},
'ca':{k:v for k,v in ca(T).items() if k in ('eigenvalues','F','G','total')},
'mca':{k:v for k,v in mca(Z,3,f).items() if k in ('eigenvalues','total','p','F','G')},
'famd':{k:v for k,v in famd(Y,fm_G,fm_blocks,f).items() if k in ('eigenvalues','total','mean','scale','bary','corr','eta')},
'linear_classical':ols(X,y,f_lr,'classical'),
'linear_hc3':ols(X,y,f_lr,'hc3'),
'factor':{'sampleCorrelation':R,'generatingLoadings':L,'generatingUniqueness':psi,
          'estimatedUniqueness':fa_result['psi'],'reproducedCorrelation':fa_result['Sigma'],
          'fitFunction':fa_result['objective']},
'conjoint_choice':fit_choice(stages,np.ones(4))}
(F/'expected_values.json').write_text(json.dumps(clean(result),ensure_ascii=False,indent=2,allow_nan=False)+'\n')
(F/'README.md').write_text('''# 合成fixture\n\nすべて個人を含まない人工データ。seed=20260912。数式の参照検証用であり、実際のアンケート結果やDAVIS-PCPのAPI応答ではない。\n\n`ca_2x2.csv`は手計算可能な二元表。`mixed_survey.csv`はMCA/FAMD用。`linear_regression.csv`はfrequency展開比較用。`factor_exact_correlation.csv`は6変数2因子の既知相関を標本相関として厳密に持つデータ。`conjoint_choice_analytic.csv`はbrandだけの2択・3対1で係数=log(3)/2。価格列はなく、価格の推定やWTPを検査するデータではない。評点・順位テンプレートはそれぞれ別CSV。\n\n`expected_values.json`の生成器はvalidation/generate_fixtures.py。将来の実装試験ではこのJSONを固定したoracleとして読み、実装値に合わせて自動上書きしない。生成時の環境はvalidation/VALIDATION_REPORT.mdに記録。\n''',encoding='utf-8')
print('Generated synthetic fixtures:',len(list(F.iterdir())))
