# Manual Prático: Usando o AuditPrompter com Claude ou Antigravity Sem API Externa Paga

Este guia mostra como qualquer aluno ou auditor pode utilizar **100% dos recursos do AuditPrompter AI** (transcrição ao vivo da reunião, insights pareados COSO/SOX/IIA/IPE, Matriz RCM, 5W2H e exportação em Word `.docx` e Excel `.xlsx`) **sem precisar pagar por uma chave de API externa**.

---

## Como a Transcrição de Áudio Funciona Sem API Paga?

A escuta ao vivo do **AuditPrompter** já é **100% gratuita por padrão**:
1. **Áudio da Reunião (Teams, Zoom, Google Meet):** capturado pelo navegador e transcrito localmente pelo servidor (`server.js`) usando **FFmpeg + Python SpeechRecognition** (`pt-BR`), sem exigir chave da OpenAI, Anthropic ou Gemini.
2. **Seu Microfone:** transcrito gratuitamente em tempo real pela API nativa de reconhecimento de voz do navegador (Google Chrome ou Microsoft Edge).
3. **Exportação de Relatórios (`.docx` e `.xlsx`):** gerada localmente em Python (`python-docx` e `openpyxl`), sem custo de API.

Para a **inteligência de análise de auditoria**, você pode escolher qualquer um dos **4 modos gratuitos** abaixo:

---

## Modo 1 — Usando com o Antigravity (Direto na IDE, Sem API Paga)

Se você está rodando o projeto dentro do **Antigravity**, o próprio agente da IDE funciona como seu **Auditor Líder de IA gratuito**, pois o AuditPrompter salva todas as falas em tempo real na pasta `projetos_auditoria/sessoes/`.

### Passo a Passo Durante a Reunião:
1. Abra a pasta do projeto no **Antigravity** e inicie o servidor (`Iniciar_Teleprompter.bat` ou `npm start`).
2. Na tela do **AuditPrompter** (`http://localhost:3000`), ative o **Áudio da Reunião** e/ou **Microfone** normalmente.
3. Clique no botão **`⚡ Claude / Antigravity (Sem API)`** na barra de ações do Mapeamento Ao Vivo.
4. Clique em **`📋 Copiar Comando para o Chat do Antigravity`** e cole no chat do Antigravity na IDE:
   > *"Leia a sessão ativa em `projetos_auditoria/sessoes/<id>.json`, analise as últimas falas da transcrição segundo COSO/SOX/IIA/IPE e atualize o arquivo JSON da sessão adicionando novos insights em `questions`, `risks`, `controls` e `pbcList`."*
5. Assim que o Antigravity atualizar o arquivo, clique em **`🔄 Sincronizar Insights do Antigravity (Disco)`** no modal do AuditPrompter. Todos os novos cards pareados, riscos RCM, controles e itens da Carta PBC aparecerão imediatamente na tela!

### Pós-Reunião com o Antigravity:
Você também pode pedir no chat do Antigravity:
- *"Revise toda a transcrição da sessão ativa em `projetos_auditoria/` e preencha o fluxo 5W2H completo (`walkthroughSteps`), a Matriz de Riscos e Controles (`risks` e `controls`) e a Carta Formal PBC (`pbcList`)."*
- Depois clique em **`🔄 Sincronizar Insights do Antigravity (Disco)`** e exporte a **Carta PBC em Word (`.docx`)** ou a **Planilha Completa em Excel (`.xlsx`)** na aba **Relatórios & Carta PBC**.

---

## Modo 2 — Usando com o Claude.ai Gratuito no Navegador (Copiar & Colar Inteligente)

Você pode usar sua conta gratuita em **[claude.ai](https://claude.ai)** (sem pagar API da Anthropic) através da ponte integrada no sistema:

### Passo a Passo:
1. Durante ou após um bloco de explicação do auditado, clique no botão **`⚡ Claude / Antigravity (Sem API)`** na barra do Mapeamento Ao Vivo.
2. Clique em **`📋 1. Copiar Prompt Completo p/ Claude.ai`**.
   - O AuditPrompter monta automaticamente o prompt de auditoria com o escopo do processo, checklist do walkthrough, falas numeradas (`[T1]`, `[T2]`, etc.) e o esquema JSON exato.
3. Abra o **[claude.ai](https://claude.ai)** em outra aba, cole o prompt (`Ctrl+V`) e envie.
4. Copie a resposta JSON gerada pelo Claude, volte ao modal do AuditPrompter, cole no campo **"2. Cole aqui a resposta JSON do Claude.ai"** e clique em **`📥 Aplicar Insights na Tela`**.
5. O AuditPrompter criará automaticamente:
   - Os **cards pareados** (`Assunto Discutido` à esquerda + `O que Perguntar & Pedir na Tela (IPE)` à direita);
   - Os **Riscos** e **Controles** na Matriz RCM;
   - Os **Pontos em Aberto** e sugestões para a **Carta PBC**.

---

## Modo 3 — Motor Especialista Local Integrado (100% Automático e Offline)

Se você não quiser alternar para o Claude.ai nem para o chat do Antigravity durante a entrevista, o AuditPrompter possui um **Motor Especialista Local** embutido em `app.js`.

### Como Ativar:
1. No menu lateral esquerdo, clique em **Motor de IA & API**.
2. Em **Provedor de Análise**, selecione:
   **`Motor Local + Ponte Claude.ai / Antigravity (100% Gratuito — Sem API Paga)`** e clique em **Salvar**.
3. Enquanto o auditado fala, o motor local detecta automaticamente padrões críticos de auditoria e gera cards pareados, riscos e controles na hora:
   - **Bypass / Aprovação fora do sistema** (aprovações por WhatsApp, e-mail, regularização posterior);
   - **Conflitos de Segregação de Funções (SoD)** (mesma área altera dados bancários/cadastro e aprova ou paga);
   - **Fragilidades de IPE em Planilhas** (extração para Excel com filtro/edição manual sem revisão independente);
   - **Violações de ITGC / Acesso** (usuário compartilhado, senha genérica, perda de trilha de auditoria);
   - **Etapas sem aprovação ou sem trava sistêmica** (sondagem automática de controle compensatório e pedido de evidência TOD na tela).

---

## Modo 4 (Bônus) — Usando Chave Gratuita do Google AI Studio (Gemini Free Tier)

Caso queira chamadas automáticas de API na nuvem sem cadastrar cartão de crédito:
1. Acesse **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** com sua conta Google pessoal e clique em **Create API Key** (plano gratuito do Google AI Studio).
2. No AuditPrompter, abra **Motor de IA & API** no menu lateral.
3. Escolha **Google Gemini** como provedor, cole a chave `AIzaSy...` no campo do Gemini (`gemini-2.5-flash`) e clique em **Salvar**.

---

## Resumo Rápido: Qual Modo Escolher?

| Cenário do Aluno | Modo Recomendado | Custo |
| :--- | :--- | :---: |
| Quer análise ao vivo rápida durante a call sem sair da tela | **Modo 3 (Motor Local)** + **Modo 2 (Claude.ai)** nos pontos críticos | **R$ 0,00** |
| Está com o projeto aberto no **Antigravity** | **Modo 1 (Antigravity lendo `projetos_auditoria/`)** | **R$ 0,00** |
| Quer usar o **Claude Sonnet** gratuitamente pelo navegador | **Modo 2 (Botão `⚡ Claude / Antigravity`)** | **R$ 0,00** |
| Quer API automática gratuita em nuvem | **Modo 4 (Google AI Studio — Gemini Flash Free Tier)** | **R$ 0,00** |
