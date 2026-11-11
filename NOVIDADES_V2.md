# AuditPrompter v2 — o que mudou

Resumo das mudanças em relação à versão 1 (preservada no GitHub na tag `v1.0`).
Para instalar ou atualizar, siga o [Manual de Instalação e Uso](./MANUAL_INSTALACAO_E_USO.md).

---

## Correções

| O que estava errado | Como ficou |
|---|---|
| **Ponte Claude.ai / Antigravity não funcionava** — "Aplicar Insights na Tela" e "Sincronizar do Disco" chamavam funções que não existiam. | As duas funções funcionam. A sincronização agora **mescla** o que o agente acrescentou, sem apagar o que está na tela. |
| **A opção "Motor Local" voltava para Claude** ao recarregar a página. | A escolha é mantida. |
| **A transcrição "100% local" enviava o áudio ao Google** (reconhecimento gratuito do Google, via Python). | O padrão passou a ser o **Whisper local** (`faster-whisper`): o áudio não sai do computador. O microfone também é transcrito localmente. Os motores de nuvem continuam disponíveis, mas só por escolha explícita em *Configurações de IA*, e um aviso fica visível enquanto estiverem ativos. O motor **nunca troca sozinho** para a nuvem. |
| **O termo de consentimento descrevia um fluxo diferente do real.** | O texto é montado conforme a configuração: diz para onde vai o áudio e para onde vai o texto. |
| **O app podia sobrescrever o que o agente da IDE gravou** (regravava o arquivo meio segundo após qualquer mudança). | O servidor detecta que o arquivo mudou por fora e o app mescla as alterações antes de gravar. |
| **Os dados das reuniões ficavam dentro da pasta do programa** (sincronizada pelo OneDrive). | Passaram para `%LOCALAPPDATA%\AuditPrompter\projetos_auditoria`. Na primeira execução o histórico antigo é **copiado** (o original é mantido). Para usar outra pasta, defina a variável `AUDITPROMPTER_DATA_DIR`. |
| **A captura podia parar quando a aba ficava oculta** (a medição de áudio dependia da animação da página, que o navegador pausa em abas ocultas). | A medição roda em temporizador e continua com a aba em segundo plano. |
| **"Aproveitar dados do projeto" copiava a reunião que estivesse aberta**, mesmo sendo de outro projeto. | Usa a reunião mais recente do próprio projeto. |

---

## Novidades

### 1. Insight mais rápido
- O áudio é cortado **nas pausas da fala** (0,8 s de silêncio), e não mais em blocos fixos de 7–12 s.
- A resposta da IA chega **em streaming**: a pergunta sugerida aparece na faixa "INSIGHT CHEGANDO…" enquanto o restante do cartão ainda está sendo gerado.
- O modelo ao vivo padrão passou a ser o **Claude Haiku 5.5** (o do relatório/ata continua sendo o Opus 5.5). Para voltar: *Configurações de IA → Modelo ao vivo*.
- A espera mínima entre análises caiu para 8 s (há também a opção de 4 s).

### 2. Importar transcrição ou gravação
Em **Transcrição & Momentos → Importar transcrição / gravação**:
- Transcrição pronta do Teams, Zoom ou Meet: `.vtt`, `.docx`, `.srt`, `.txt`.
- Gravação de áudio ou vídeo (`.mp3`, `.m4a`, `.wav`, `.mp4`, `.webm`…): transcrita pelo Whisper local, com barra de progresso.
- Depois de importar, o app pergunta quem é da auditoria e oferece gerar os insights, riscos e controles em lotes.

### 3. Print da tela como evidência
- Com o "Áudio da Reunião" ligado (a janela/aba da reunião compartilhada), **★ Momento** (Ctrl+Alt+M) e **📸 Print** (Ctrl+Alt+S) salvam o quadro atual da tela com uma faixa de data/hora, projeto e reunião.
- Os prints aparecem nos Momentos, na prévia do papel de trabalho e no **Word** exportado (seção 6).
- Ficam gravados só neste computador, em `…\projetos_auditoria\evidencias\<reunião>\`.

### 4. Quem está falando (identificação assistida)
- Cadastre os participantes em *Preparação* (`Nome — Cargo — Papel`). Os entrevistados viram botões na barra **QUEM ESTÁ FALANDO**; o áudio da reunião é atribuído a quem estiver selecionado (Ctrl+Alt+1…9).
- Na transcrição, clique no nome (✎) para corrigir quem falou, uma fala ou um bloco seguido.
- **Limite:** a troca de locutor é feita pelo auditor; o app não reconhece vozes automaticamente.

### 5. Memória entre reuniões do projeto
- Ao criar uma nova reunião, o app carrega o que já foi mapeado nas anteriores e traz as **pendências em aberto**. A IA recebe esse histórico para não repetir assuntos e apontar contradições.
- **Projetos & Histórico → Visão consolidada do projeto**: riscos, controles, PBC e pendências de todas as reuniões, sem duplicidade, com exportação em CSV.

### 6. Encerramento da reunião
- Botão **Encerrar reunião** (Ctrl+Alt+E): mostra perguntas críticas não feitas, etapas do checklist não cobertas, pontos em aberto, PBC sem responsável/prazo e riscos sem controle — enquanto o entrevistado ainda está na sala — e sugere a fala de fechamento.
- Ao confirmar, as perguntas críticas não feitas viram pontos em aberto, a captura é encerrada e o app abre o papel de trabalho.

---

## Requisitos novos
- `faster-whisper` (instalado automaticamente pelo `Iniciar_Teleprompter.bat`). Na **primeira** transcrição o modelo "small" (~460 MB) é baixado uma única vez; depois funciona sem internet.
- Para trocar o modelo: variável `AUDITPROMPTER_WHISPER_MODEL` (`base` é mais rápido; `medium` é mais preciso e mais lento).
- O FFmpeg deixou de ser necessário para o Whisper local (continua sendo usado só pelo motor gratuito do Google).

## Manuais
- Os dois manuais em PDF da versão 1 foram substituídos por `Manual_AuditPrompter_Instalacao_e_Uso.pdf` (e pela versão em Markdown, `MANUAL_INSTALACAO_E_USO.md`). Os antigos continuam disponíveis na tag `v1.0`.
