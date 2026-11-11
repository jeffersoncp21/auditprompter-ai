# AuditPrompter AI — Teleprompter & Copiloto de Auditoria Interna Ao Vivo

Aplicação web local para condução de entrevistas de **Mapeamento de Processos**, **Walkthroughs (Test of Design — TOD)** e avaliação de **Controles Internos** alinhada às metodologias **COSO ICIF-2013**, **SOX (PCAOB AS 2201)**, **IIA (IPPF / 3 Linhas)**, **ITGC** e **IPE (Information Produced by the Entity)**.

---

## Principais Funcionalidades

1. **Teleprompter Pareado Ao Vivo (`Assunto Discutido` ↔ `Insight & O que Perguntar`)**
   - Escuta o **Áudio da Reunião** (Teams, Zoom, Meet via compartilhamento de guia/janela com áudio) e/ou o **Microfone**.
   - Organiza automaticamente o que foi falado em tópicos estruturados à esquerda e exibe à direita **o que perguntar agora** e **qual evidência/tela pedir na hora (IPE / TOD)**.
2. **Controle por Projetos de Auditoria & Histórico em Disco**
   - Criação de múltiplos projetos de auditoria (`AUD-2026-01`, etc.) com múltiplas reuniões vinculadas.
   - Salvamento automático em disco (`projetos_auditoria/`) de toda a transcrição, insights, matriz de riscos, controles e lista PBC.
   - Busca textual no histórico para localizar qualquer termo dito em reuniões anteriores e retomar a sessão com 1 clique.
3. **Mapeamento Estruturado 5W2H & Matriz de Riscos e Controles (RCM)**
   - Extração automática e edição de etapas do processo (5W2H), riscos inerentes e controles (Preventivo/Detectivo, Manual/Automático/ITDM, Frequência e Avaliação TOD).
4. **Central de Relatórios & Carta Formal de Solicitação (PBC / RFI)**
   - **Word (`.docx`) — Carta Formal de Solicitação de Documentos e Evidências (PBC / RFI):** documento executivo em paisagem com numeração estruturada (`PBC-001`), categorização metodológica (Governança, Walk-through/TOD, Populações/IPE, Amostragem, ITGC) e **Protocolo Metodológico de IPE** (Parâmetros, Fonte/Query, Carimbo de Tempo, Completude/Batimento e Trilha de Auditoria).
   - **Word (`.docx`) — Papel de Trabalho Completo (Walkthrough TOD, Ata, 5W2H & Matriz RCM).**
   - **Excel (`.xlsx`) — Planilha Multi-Abas de Auditoria:** inclui aba de controle PBC com validação de status para o auditado preencher, Guia de Evidências IPE, Matriz RCM, 5W2H e Registro da Reunião.

---

## Pré-requisitos

- **[Node.js](https://nodejs.org/)** (versão 18 ou superior)
- **[Python 3.9+](https://www.python.org/downloads/)** (para geração nativa de arquivos `.docx` / `.xlsx` e transcrição local de áudio)
- **[FFmpeg](https://ffmpeg.org/)** *(opcional, recomendado para captura contínua do áudio da reunião do sistema)*
  - No Windows (via Winget ou Chocolatey): `winget install Gyan.FFmpeg` ou `choco install ffmpeg`
- **Navegador recomendado:** Google Chrome ou Microsoft Edge (para suporte completo a captura de áudio de guia/sistema e Web Speech API).

---

## Como Instalar e Executar

### Opção 1 — Atalho Rápido no Windows (Recomendado)
Basta dar um duplo clique no arquivo **`Iniciar_Teleprompter.bat`**.
Ele instalará automaticamente as dependências do Node.js e do Python na primeira execução e abrirá o sistema em `http://localhost:3000`.

### Opção 2 — Via Terminal
```bash
# 1. Instalar dependências do servidor Node.js
npm install

# 2. Instalar bibliotecas Python (exportação Word/Excel e transcrição)
pip install -r requirements.txt

# 3. Iniciar o servidor local (abre automaticamente em http://localhost:3000)
npm start
```

---

## Configuração de Inteligência Artificial (Opcional)

O **AuditPrompter** já conta com um **Motor Especialista Local Gratuito** integrado (baseado em regras COSO/SOX/IIA), funcionando mesmo sem chave de API.

Para habilitar análises avançadas com LLMs em tempo real:
1. No menu lateral esquerdo, clique em **Motor de IA & API**.
2. Insira sua chave da **Anthropic (Claude Sonnet / Opus)** ou do **Google Gemini**.
3. As chaves ficam salvas **exclusivamente no seu computador** (em `%APPDATA%\AuditPrompter\config.json`) e nunca são expostas no navegador ou no repositório Git.

---

## Estrutura do Projeto

- `server.js` — Servidor local (`127.0.0.1:3000`), proxy seguro para APIs de IA, endpoint de transcrição local (`/api/transcribe`), persistência de projetos (`/api/projects`) e exportação Office (`/api/export`).
- `app.js` — Lógica da aplicação, captura de áudio, motor local de auditoria, gerenciamento de estado e interface.
- `templates.js` — Biblioteca de templates de processos (Compras/P2P, Financeiro, TI/Acessos, RH/Folha, etc.) com perguntas roteirizadas, riscos e controles padrão.
- `export_builder.py` — Gerador de relatórios corporativos em `.docx` (`python-docx`) e `.xlsx` (`openpyxl`).
- `index.html` & `styles.css` — Interface limpa com menu lateral e visão pareada de teleprompter.
