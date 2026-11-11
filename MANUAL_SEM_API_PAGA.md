# Manual Oficial Completo: Usando o AuditPrompter AI COM API e SEM API Externa

Este guia apresenta o passo a passo completo para instalar, configurar e operar o **AuditPrompter AI** tanto no modo **100% automatizado COM API Externa (Anthropic Claude / Google Gemini)** quanto no modo **SEM API Externa Paga (Antigravity na IDE, Claude.ai Web Gratuito e Motor Especialista Local)**.

---

## Parte 1 — Instalação e Captura de Áudio da Reunião

### 1.1 Pré-requisitos e Inicialização
- **Pré-requisitos:** [Node.js](https://nodejs.org/) (v18+), [Python 3.9+](https://www.python.org/), navegador Chrome/Edge e FFmpeg (`winget install Gyan.FFmpeg`).
- **Inicialização Rápida no Windows:** Dê duplo clique em **`Iniciar_Teleprompter.bat`** (instala dependências Node/Python e abre `http://localhost:3000`).
- **Via Terminal:**
  ```bash
  git clone https://github.com/jeffersoncp21/auditprompter-ai.git
  cd auditprompter-ai
  npm install && pip install -r requirements.txt && npm start
  ```

### 1.2 Ligando a Escuta Ao Vivo
1. No topo da tela, clique em **Áudio da Reunião**, escolha a guia/janela da call (Teams, Zoom, Google Meet) e marque **Compartilhar áudio da guia/sistema**.
2. Clique em **Microfone** para registrar também as perguntas feitas por você (auditor).

---

## Parte 2 — Uso COM API Externa (Automação 100% em Tempo Real)

Com uma chave de API configurada, o AuditPrompter analisa automaticamente cada pausa na fala do auditado, gera cards pareados na hora e consolida a Carta PBC e o Papel de Trabalho com 1 clique.

### 2.1 Configurando com API da Anthropic (Claude Opus / Sonnet / Haiku)
1. Acesse **[console.anthropic.com](https://console.anthropic.com)** (*Settings → API Keys*) e gere uma chave (`sk-ant-api03-...`). Certifique-se de ter créditos ativos em *Billing*.
2. No menu lateral esquerdo do AuditPrompter, clique em **Motor de IA & API**.
3. Em **Provedor de Análise**, selecione **Anthropic Claude (via API Key)** e cole sua chave no campo da Anthropic.
4. Escolha os modelos recomendados:
   - **Modelo ao vivo (insights):** `Claude Sonnet 5.5` (mais rápido) ou `Claude Opus 5.5` (máximo rigor analítico), com profundidade **Baixa** durante a entrevista.
   - **Modelo do relatório / ata:** `Claude Opus 5.5`.
5. Clique em **Testar Anthropic** para validar a conexão e depois em **Salvar**.
   - *Segurança:* Sua chave fica gravada apenas no seu computador (`%APPDATA%\AuditPrompter\config.json`), fora do navegador e do Git.

### 2.2 Configurando com API do Google Gemini (Plano Pago ou Gratuito AI Studio)
1. Acesse **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** e clique em **Create API Key** (`AIzaSy...`). Funciona tanto no plano gratuito do Google AI Studio quanto em contas faturadas do Google Cloud.
2. Em **Motor de IA & API**, escolha **Google Gemini (via API Key)** como Provedor de Análise e cole sua chave no bloco Google Gemini.
3. Selecione `gemini-2.5-flash` (rápido para reuniões ao vivo) ou `gemini-2.5-pro`, clique em **Testar Gemini** e depois em **Salvar**.

---

## Parte 3 — Uso SEM API Externa Paga (Custo Zero com Claude ou Antigravity)

Mesmo sem nenhuma chave de API paga, a transcrição do áudio da reunião continua funcionando gratuitamente via **FFmpeg + Python SpeechRecognition** local. Para a análise de auditoria, use qualquer uma das 3 opções abaixo:

### 3.1 Modo Sem API A — Usando com o Antigravity Direto na IDE
Todas as falas da reunião são salvas em tempo real em `projetos_auditoria/sessoes/<id>.json`. Ao abrir a pasta do projeto no **Antigravity**:
1. Clique no botão **`⚡ Claude / Antigravity (Sem API)`** na barra do Mapeamento Ao Vivo.
2. Clique em **`📋 Copiar Comando para o Chat do Antigravity`** e cole no chat do Antigravity na IDE:
   > *"Leia a sessão ativa em `projetos_auditoria/sessoes/<id>.json`, analise as últimas falas da transcrição segundo COSO/SOX/IIA/IPE e atualize o arquivo JSON da sessão adicionando novos insights em `questions`, `risks`, `controls` e `pbcList`."*
3. Assim que o Antigravity atualizar o arquivo, clique em **`🔄 Sincronizar Insights do Antigravity (Disco)`** para exibir todos os novos cards pareados, riscos, controles e itens PBC na tela!

### 3.2 Modo Sem API B — Usando com o Claude.ai Gratuito no Navegador
1. Clique no botão **`⚡ Claude / Antigravity (Sem API)`** na barra do Mapeamento Ao Vivo.
2. Clique em **`📋 1. Copiar Prompt Completo p/ Claude.ai`** (copia o contexto do processo, as falas recentes `[T1]`, `[T2]`... e o esquema JSON).
3. Abra **[claude.ai](https://claude.ai)** no navegador, cole o prompt (`Ctrl+V`) e envie.
4. Copie a resposta JSON gerada pelo Claude, cole no campo do modal no AuditPrompter e clique em **`📥 Aplicar Insights na Tela`**.

### 3.3 Modo Sem API C — Motor Especialista Local Integrado (100% Offline)
Em **Motor de IA & API**, selecione **`Motor Local + Ponte Claude.ai / Antigravity (100% Gratuito — Sem API Paga)`**. O motor local analisa cada fala do auditado e gera automaticamente cards pareados, riscos e controles para:
- **Aprovações fora do sistema / Bypass** (WhatsApp, e-mail, regularização posterior);
- **Conflitos de Segregação de Funções (SoD)**;
- **Planilhas manuais sem revisão independente (Risco de IPE)**;
- **Usuários compartilhados ou genéricos (Violação de ITGC)**;
- **Etapas sem aprovação ou sem trava sistêmica**.

---

## Parte 4 — Gestão de Projetos, Histórico e Exportação (.docx / .xlsx)

- **Projetos & Histórico:** Crie projetos (`AUD-2026-01`), agrupe várias reuniões no mesmo projeto, pesquise termos falados em qualquer reunião anterior e retome sessões com 1 clique.
- **Carta Formal PBC / RFI em Word (`.docx`):** Documento executivo em paisagem com numeração `PBC-001`, 5 categorias IIA/COSO/SOX, Pontos em Aberto e **Protocolo Metodológico de IPE**.
- **Papel de Trabalho Completo (`.docx`) e Planilha Multi-Abas (`.xlsx`):** Exportação nativa do Walkthrough (TOD + 5W2H + Matriz RCM) e planilha Excel com aba de controle de status para o auditado preencher.

---

## Quadro Comparativo Geral: Com API vs. Sem API Externa

| Modalidade | Configuração em `Motor de IA & API` | Como Gera os Insights e Relatórios | Custo de API |
| :--- | :--- | :--- | :---: |
| **COM API — Anthropic Claude** | Provedor: **Anthropic Claude** + chave `sk-ant-...` | 100% automático após pausa na fala + consolidação de PBC/Ata com 1 clique | Créditos API Anthropic |
| **COM API — Google Gemini** | Provedor: **Google Gemini** + chave `AIzaSy...` | 100% automático via nuvem Google (aceita Free Tier do Google AI Studio ou pago) | Grátis (Free Tier) ou Pago |
| **SEM API — Antigravity IDE** | Provedor: **Motor Local + Ponte** | Agente na IDE lê/atualiza `projetos_auditoria/` + botão **Sincronizar do Disco** | **R$ 0,00 (Sem API)** |
| **SEM API — Claude.ai Web** | Provedor: **Motor Local + Ponte** | Botão copia prompt pronto com a transcrição e injeta o JSON do Claude na tela | **R$ 0,00 (Sem API)** |
| **SEM API — Motor Local** | Provedor: **Motor Local + Ponte** | Regras COSO/SOX/IIA/IPE instantâneas + transcrição local Python/FFmpeg | **R$ 0,00 (100% Local)** |
