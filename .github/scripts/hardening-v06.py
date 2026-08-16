from pathlib import Path

agent_path=Path('netlify/lib/agent.mjs')
app_path=Path('public/app.js')
css_path=Path('public/app.css')
agent=agent_path.read_text(); app=app_path.read_text(); css=css_path.read_text()

def rep(text,old,new,label):
    if old not in text: raise SystemExit(f'faltou {label}')
    return text.replace(old,new,1)

# Produto só é confirmado se também houver foto; candidatos não gastam IA antes disso.
agent=rep(agent,
"    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,\n    verified: Boolean(link), verifiedAt: link ? now : null, observedPrice: '', lastSyncSeenAt: null,",
"    mediaKey: saved?.mediaKey || '', imageMime: saved?.imageMime || '', active: true, source,\n    verified: Boolean(link && (saved?.mediaKey || imageUrl)), verifiedAt: link && (saved?.mediaKey || imageUrl) ? now : null, observedPrice: '', lastSyncSeenAt: null,",
'create verified foto')
agent=rep(agent,
"    if (!p.shopeeUrl) throw new Error('Produto sem link específico da Shopee.');\n    return {",
"    if (!p.shopeeUrl) throw new Error('Produto sem link específico da Shopee.');\n    if (!p.mediaKey && !p.imageUrl) throw new Error('Adicione uma foto real antes de confirmar o produto.');\n    return {",
'confirm foto')

# Ajuste de composição: variante com foto superior não invade rodapé.
agent=rep(agent,
"      titleY = 790; titleWidth = 850; titleSize = 55;",
"      titleY = 720; titleWidth = 850; titleSize = 46;",
'creative top geometry')
agent=rep(agent,
"  const titleLines = wrapTextPx(headline, titleWidth, titleSize, isSale ? 4 : 5);\n  const subSize = isSale ? 34 : 32;\n  const subLines = wrapTextPx(sub, titleWidth, subSize, isSale ? 2 : 3);",
"  const titleLines = wrapTextPx(headline, titleWidth, titleSize, isSale ? (variant % 3 === 0 ? 3 : 4) : 5);\n  const subSize = isSale ? (variant % 3 === 0 ? 28 : 34) : 32;\n  const subLines = wrapTextPx(sub, titleWidth, subSize, isSale ? (variant % 3 === 0 ? 1 : 2) : 3);",
'creative line caps')
agent=rep(agent,
"    ${svgLines(subLines,{x:titleX,y:titleY + titleLines.length*Math.round(titleSize*1.12)+42,size:subSize,gap:44,color:'#475569',weight:600,anchor:align})}",
"    ${svgLines(subLines,{x:titleX,y:titleY + titleLines.length*Math.round(titleSize*1.12)+(isSale && variant % 3 === 0 ? 26 : 42),size:subSize,gap:44,color:'#475569',weight:600,anchor:align})}",
'creative sub y')

# Sem style inline: progress nativo estilizado por CSS, permitindo CSP estrita.
old="`<div class=\"usage-row\"><span>${name}</span><div class=\"usage-bar\"><i style=\"width:${Math.min(100,max?val/max*100:0)}%\"></i></div><strong>${val}/${max}</strong></div>`"
new="`<div class=\"usage-row\"><span>${name}</span><progress class=\"usage-bar\" max=\"100\" value=\"${Math.min(100,max?val/max*100:0)}\"></progress><strong>${val}/${max}</strong></div>`"
app=rep(app,old,new,'usage progress')
css=rep(css,
".usage-bar{height:8px;border-radius:999px;background:#080e17;overflow:hidden;border:1px solid #1d293b}.usage-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--mint),#5cf595);border-radius:inherit}",
".usage-bar{width:100%;height:9px;border:0;border-radius:999px;overflow:hidden;background:#080e17}.usage-bar::-webkit-progress-bar{background:#080e17;border-radius:999px}.usage-bar::-webkit-progress-value{background:linear-gradient(90deg,var(--mint),#5cf595);border-radius:999px}.usage-bar::-moz-progress-bar{background:linear-gradient(90deg,var(--mint),#5cf595);border-radius:999px}",
'progress css')

# Pequeno acabamento de detalhes técnicos e botões de atenção.
css += "\n.attention-item{width:100%;color:inherit;text-align:left}.audit-row details{margin-top:6px;color:#64748b;font-size:9px}.audit-row summary{cursor:pointer}.audit-row code{display:block;margin-top:5px;white-space:pre-wrap;word-break:break-word;color:#8292aa}\n"

agent_path.write_text(agent);app_path.write_text(app);css_path.write_text(css)
print('hardening v0.6 aplicado')
