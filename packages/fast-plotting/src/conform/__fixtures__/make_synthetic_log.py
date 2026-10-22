# Regenerate: python3 make_synthetic_log.py synthetic-log.csv > synthetic-log.expected.json
# Synthetic Conform log: same 24-column header as the machine export, 900 rows at 1 Hz.
# Deterministic (no RNG). Steps: 3.0 rpm (84 rows), blip 3.5 (4), 4.0 (208), blip 4.5 (2), 5.0 (602).
import math, json, sys, datetime as dt
out = sys.argv[1]
H = ["Timestamp","Machine Cooling Temp. (°C)","Product Cooling Temp. (°C)","Wheel Cooling Pump Current (A)","Wheel Cooling Demand (%)","Wheel Cooling Pump Torque (%)","IPS Control Temperature (C)","IPS Coolant Temp (°C)","IPS Output (%)","IPS Setpoint (°C)","IPS Work Coil VA","Analogue Input 1","Bearing Oil Temperature (°C)","Gearbox Oil Temperature (°C)","Motor Current (A)","Motor Torque (%)","Tooling Temperature 1 (°C)","Tooling Temperature 2 (°C)","Wheel Temperature (°C)","Wheel Temperature 1 (°C)","Wheel Temperature 2 (°C)","Wheel Speed (rpm)","Wheel Speed Demand (rpm)","Powder Feeder Demand (%)","Powder Feeder Setting (%)"]
t0 = dt.datetime(2025,1,15,10,0,0,tzinfo=dt.timezone.utc)
def demand(i):
    if i < 84: return 3.0
    if i < 88: return 3.5
    if i < 296: return 4.0
    if i < 298: return 4.5
    return 5.0
rows=[]
for i in range(900):
    d = demand(i)
    ws = round(d + 0.05*math.sin(i/7), 4)
    torque = round((6.0 if i < 30 else 18.0 + 4.0*math.sin(i/11)), 4)   # first 30 s below the 10 % extruding threshold
    cur = round(2.2*torque + 3.0, 4)
    t1 = round(300.0 + 0.145*i, 4)
    t2 = round(24.0 + 0.3*math.sin(i/50), 4)                            # flat: within ±1 °C
    wt = round(34.0 + 0.07*i, 4)
    va = (9600 if i % 10 < 3 else 13400) if i % 2 == 0 else 4
    cool = round(0.002 + 0.001*(i % 3), 4)
    r = [ (t0+dt.timedelta(seconds=i)).strftime('%Y-%m-%dT%H:%M:%S.0000000Z'),
          21.9, 22.4, cool, 0, 0, round(470+0.02*i,3), 420, round(3.5+0.5*math.sin(i/9),4), 500, va, 0.0001,
          26.3, 25.5, cur, torque, t1, t2, wt, round(wt-5,4), wt, ws, d, 0, 60.2 ]
    rows.append(r)
with open(out,'w',newline='') as f:
    f.write(','.join(H)+'\n')
    for r in rows: f.write(','.join(str(x) for x in r)+'\n')
# goldens, computed straight from the formulas in the plan
k=math.sqrt(3)*400/1000
col=lambda n:[float(r[H.index(n)]) for r in rows]
I=col('Motor Current (A)');VA=col('IPS Work Coil VA');C=col('Wheel Cooling Pump Current (A)')
W=col('Wheel Speed (rpm)');TQ=col('Motor Torque (%)');T1=col('Tooling Temperature 1 (°C)');T2=col('Tooling Temperature 2 (°C)');WT=col('Wheel Temperature (°C)')
pm=[k*0.85*x for x in I];pi=[0.95*x/1000 for x in VA];pc=[k*0.8*x for x in C]
ext=[j for j in range(900) if W[j]>=1 and TQ[j]>10]
mean=lambda a,ix:sum(a[j] for j in ix)/len(ix)
g=dict(n=900,duration_s=899,energy=dict(motor=sum(pm)/3600,ips=sum(pi)/3600,cooling=sum(pc)/3600,total=(sum(pm)+sum(pi)+sum(pc))/3600),
 extruding_s=len(ext),mean_wheel=mean(W,ext),mean_torque=mean(TQ,ext),mean_t1=mean(T1,ext),
 peak_torque=max(TQ),peak_current=max(I),peak_t1=max(T1),peak_wheel_temp=max(WT))
steps=[]
for a,b in [(0,84),(88,296),(298,900)]:
    ix=range(a,b)
    steps.append(dict(start=rows[a][0],rows=b-a,rpm=demand(a),t1=[min(T1[j] for j in ix),max(T1[j] for j in ix)],mean_torque=mean(TQ,ix),energy=sum(pm[j]+pi[j]+pc[j] for j in ix)/3600))
g['steps']=steps
g['sub_window_298_end_energy']=sum(pm[j]+pi[j]+pc[j] for j in range(298,900))/3600
print(json.dumps(g,indent=1))
