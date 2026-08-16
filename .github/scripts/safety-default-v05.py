from pathlib import Path
p=Path('netlify/lib/agent.mjs')
s=p.read_text()
s=s.replace("if (!boolEnv('AUTO_PLAN', true)) return { autoPlan: false, type };", "if (!boolEnv('AUTO_PLAN', false)) return { autoPlan: false, type };")
s=s.replace("openai: Boolean(process.env.OPENAI_API_KEY), autoPlan: boolEnv('AUTO_PLAN', true), autoApprovePlanner: boolEnv('AUTO_APPROVE_PLANNER', false),", "openai: Boolean(process.env.OPENAI_API_KEY), autoPlan: boolEnv('AUTO_PLAN', false), autoApprovePlanner: boolEnv('AUTO_APPROVE_PLANNER', false),")
p.write_text(s)

env=Path('.env.example')
e=env.read_text().replace('AUTO_PLAN=true', 'AUTO_PLAN=false')
env.write_text(e)

readme=Path('README.md')
r=readme.read_text().replace('AUTO_PLAN=true\nAUTO_APPROVE_PLANNER=false', 'AUTO_PLAN=false\nAUTO_APPROVE_PLANNER=false')
r=r.replace('Depois de alguns dias de revisão, ative primeiro `AUTO_APPROVE_PLANNER=true`.', 'Para iniciar a preparação automática, defina primeiro `AUTO_PLAN=true`. Depois de alguns dias de revisão, ative `AUTO_APPROVE_PLANNER=true`.')
readme.write_text(r)

ch=Path('CHANGELOG.md')
c=ch.read_text()
if 'fail-safe' not in c.lower():
    c=c.replace('## v0.5.0\n', '## v0.5.0\n- Fail-safe: `AUTO_PLAN` fica desligado se não for explicitamente configurado como `true`.\n')
ch.write_text(c)
