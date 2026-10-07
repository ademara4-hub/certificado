# Certificado de Içamento

App web (celular) para gerar certificados de inspeção de acessórios de içamento
(cinta, manilha, cabo de aço, corrente). A foto da etiqueta é lida pelo Gemini
para preencher os dados automaticamente.

## Estrutura

```
index.html                página (fotos → dados + checklist → certificado)
functions/api/analyze.js  Cloudflare Pages Function: POST /api/analyze
_routes.json              envia só /api/* para as Functions
```

## Deploy (Cloudflare Pages)

1. Conecte este repositório ao Cloudflare Pages (sem comando de build, diretório de saída `/`).
2. Em *Settings → Variables and Secrets*, configure:
   - `GEMINI_API_KEY` (obrigatório, como secret)
   - `GEMINI_MODEL` (opcional; padrão `gemini-flash-latest`)

O endpoint aceita apenas `{ image, mimeType }` vindos do mesmo domínio; o prompt
e o modelo ficam no servidor.
