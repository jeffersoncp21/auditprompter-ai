<p align="center">
  <a href="https://aiauditor.com.br"><img src="docs/img/auditor-do-futuro.png" alt="Auditor do Futuro" width="380"></a>
</p>

# AuditPrompter AI — Teleprompter & Copiloto de Auditoria Interna Ao Vivo

**Criado por [Jefferson Cavalcante](https://www.linkedin.com/in/jefferson-pereira/) — [Auditor do Futuro](https://aiauditor.com.br).** Gratuito e de código aberto.
[Treinamentos](https://aiauditor.com.br/cursos/) · [Mentoria](https://aiauditor.com.br/mentoria/) · [Para times de auditoria](https://aiauditor.com.br/solucoes/) · [Ebook Método 3X](https://ebook.aiauditor.com.br/) · [LinkedIn](https://www.linkedin.com/in/jefferson-pereira/)

Aplicação web local para condução de entrevistas de **Mapeamento de Processos**, **Walkthroughs (Test of Design — TOD)** e avaliação de **Controles Internos** alinhada às metodologias **COSO ICIF-2013**, **SOX (PCAOB AS 2201)**, **IIA (IPPF / 3 Linhas)**, **ITGC** e **IPE (Information Produced by the Entity)**.

---

> 📘 **Primeira vez aqui?** Siga o **[Manual de Instalação e Uso](./MANUAL_INSTALACAO_E_USO.md)** (também em [PDF](./Manual_AuditPrompter_Instalacao_e_Uso.pdf)): instalação do zero, passo a passo e com prints, pelo caminho manual ou com Claude Code, Gemini CLI, Antigravity ou Codex.
>
> **Versão 2.** O resumo do que mudou em relação à versão 1 está em [`NOVIDADES_V2.md`](./NOVIDADES_V2.md).

## Principais Funcionalidades

1. **Teleprompter Pareado Ao Vivo (`Assunto Discutido` ↔ `Insight & O que Perguntar`)**
   - Escuta o **Áudio da Reunião** (Teams, Zoom, Meet via compartilhamento de guia/janela com áudio) e/ou o **Microfone**.
   - Organiza automaticamente o que foi falado em tópicos estruturados à esquerda e exibe à direita **o que perguntar agora** e **qual evidência/tela pedir na hora (IPE / TOD)**.
   - **Transcrição 100% local (Whisper):** o áudio da reunião e do microfone não sai do computador. O áudio é cortado nas pausas da fala e o insight chega em streaming.
   - **Quem está falando:** barra de participantes para atribuir cada fala ao entrevistado certo (identificação assistida pelo auditor).
   - **Print da tela como evidência:** cada momento marcado guarda o quadro da tela compartilhada, com data e hora.
   - **Importação pós-reunião:** transcrição pronta do Teams/Zoom/Meet (`.vtt`, `.docx`, `.srt`, `.txt`) ou gravação de áudio/vídeo.
   - **Encerramento da reunião:** revisão do que ficou pendente antes de liberar os participantes.
2. **Controle por Projetos de Auditoria & Histórico em Disco**
   - Criação de múltiplos projetos de auditoria (`AUD-2026-01`, etc.) com múltiplas reuniões vinculadas, memória entre reuniões e visão consolidada (RCM sem duplicidade).
   - Salvamento automático em disco, fora da pasta do programa e do OneDrive (`%LOCALAPPDATA%\AuditPrompter\projetos_auditoria`), de toda a transcrição, insights, matriz de riscos, controles, lista PBC e prints.
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
- **[Python 3.9+](https://www.python.org/downloads/)** (para geração nativa de arquivos `.docx` / `.xlsx` e transcrição local de áudio com `faster-whisper`)
  - Na primeira transcrição, o modelo Whisper "small" (~460 MB) é baixado uma única vez; depois funciona sem internet.
- **[FFmpeg](https://ffmpeg.org/)** *(opcional — só é usado se você escolher o motor de transcrição gratuito do Google, em nuvem)*
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

## Configuração de Inteligência Artificial (100% Gratuito ou com API)

> 📘 **[Leia o Manual Completo: Como usar com Claude.ai ou Antigravity SEM API Paga (`MANUAL_SEM_API_PAGA.md`)](./MANUAL_SEM_API_PAGA.md)**

O **AuditPrompter** funciona **sem nenhuma API externa paga**:
- **Transcrição Ao Vivo Gratuita e Local:** O áudio da reunião e o microfone são transcritos pelo **Whisper local** (`faster-whisper`), sem custo e sem enviar áudio à internet. Os motores de nuvem (Google Gemini ou reconhecimento gratuito do Google) só são usados se você os escolher em *Configurações de IA* — nesse caso o áudio é enviado ao Google e um aviso fica visível na tela.
- **O que sai do computador:** com um provedor de IA configurado (Claude ou Gemini), o **texto** transcrito é enviado a ele para gerar os insights. Com o Motor Local, nada é enviado.
- **Ponte `⚡ Claude / Antigravity (Sem API)` na tela principal:**
  1. **Com o Antigravity (na IDE):** O Antigravity lê e atualiza a sessão ativa em `<pasta de dados>\sessoes\<id>.json` (o botão **Copiar Comando** já leva o caminho completo) e você traz os itens novos com 1 clique no botão **`🔄 Sincronizar Insights do Antigravity (Disco)`** — eles são mesclados à tela, sem apagar nada.
  2. **Com o Claude.ai Gratuito (Web):** Clique em **`📋 Copiar Prompt Completo p/ Claude.ai`**, cole no [claude.ai](https://claude.ai) gratuito e cole o JSON gerado de volta em **`📥 Aplicar Insights na Tela`**.
  3. **Motor Especialista Local Integrado:** Gera automaticamente perguntas TOD/IPE, riscos e controles para falas sobre aprovações fora do sistema, conflitos de SoD, planilhas manuais (IPE) e acessos compartilhados (ITGC).

Para habilitar chamadas diretas via chave de API (opcional):
1. No menu lateral esquerdo, clique em **Configurações de IA**.
2. Insira sua chave da **Anthropic** ou uma chave gratuita do **Google AI Studio (Gemini)**.
3. As chaves ficam salvas **exclusivamente no seu computador** (em `%APPDATA%\AuditPrompter\config.json`) e nunca são expostas no navegador ou no repositório Git.

---

## Estrutura do Projeto

- `server.js` — Servidor local (`127.0.0.1:3000`), proxy seguro para APIs de IA (com streaming), transcrição local (`/api/transcribe`), importação de gravações, prints de evidência, persistência de projetos (`/api/projects`) e exportação Office (`/api/export`).
- `transcribe_worker.py` — Processo do Whisper local (`faster-whisper`) usado pelo servidor.
- `app.js` — Lógica da aplicação, captura de áudio, motor local de auditoria, gerenciamento de estado e interface.
- `extras.js` — Funcionalidades da v2: locutores, importação de transcrição/gravação, prints, memória e visão consolidada do projeto, encerramento da reunião.
- `templates.js` — Biblioteca de templates de processos (Compras/P2P, Financeiro, TI/Acessos, RH/Folha, etc.) com perguntas roteirizadas, riscos e controles padrão.
- `export_builder.py` — Gerador de relatórios corporativos em `.docx` (`python-docx`) e `.xlsx` (`openpyxl`).
- `index.html` & `styles.css` — Interface limpa com menu lateral e visão pareada de teleprompter.

---

## Quem criou

O AuditPrompter é um projeto do **Auditor do Futuro**, de **Jefferson Cavalcante** — auditor e instrutor de IA aplicada à auditoria interna.

| | |
|---|---|
| 🎬 **Treinamentos** (Claude e Copilot para auditoria) | https://aiauditor.com.br/cursos/ |
| 👤 **Mentoria anual** | https://aiauditor.com.br/mentoria/ |
| 🏢 **Soluções para times de auditoria** (Método 3X, in company) | https://aiauditor.com.br/solucoes/ |
| 📘 **Ebook: Método 3X** | https://ebook.aiauditor.com.br/ |
| 📊 **Diagnóstico gratuito da sua auditoria** | https://aiauditor.com.br/diagnostico/ |
| 💼 **LinkedIn** | https://www.linkedin.com/in/jefferson-pereira/ |
| 💬 **Contato** | https://aiauditor.com.br/jefferson/ |

