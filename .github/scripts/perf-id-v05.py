from pathlib import Path
p=Path('netlify/lib/agent.mjs')
s=p.read_text()
old='metaPostId: result.id || result.post_id || null'
new='metaPostId: result.post_id || result.id || null'
assert old in s, 'expressão metaPostId não encontrada'
p.write_text(s.replace(old,new))

ch=Path('CHANGELOG.md')
c=ch.read_text()
if 'post_id' not in c:
    c=c.replace('## v0.5.0\n', '## v0.5.0\n- Métricas priorizam `post_id` da Meta quando disponível, preservando o ID do post de feed.\n')
ch.write_text(c)
