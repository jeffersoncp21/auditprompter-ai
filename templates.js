// Modelos de auditoria pré-configurados, checklist padrão e cenários de simulação.
// Carregado antes de app.js.
// ============================================================================
// TEMPLATES DE MELHORES PRÁTICAS DE AUDITORIA INTERNA (COSO / SOX / IIA / ITGC)
// ============================================================================
const AUDIT_TEMPLATES = {
  p2p: {
    topic: 'Processo de Compras, Aprovação de Pedidos e Pagamentos (Procure-to-Pay)',
    methodology: 'walkthrough_coso',
    scope: 'ERP (SAP/TOTVS/Oracle), Portal de Compras, Cadastro de Fornecedores e Contas a Pagar',
    coachingTip: 'Validar: (1) Segregação entre cadastro de fornecedor, pedido e aprovação; (2) Bloqueio de edições pós-aprovação no ERP; (3) Compras emergenciais sem pedido (bypass) e Three-Way Match.',
    questions: [
      {
        id: 'q-p2p-1',
        priority: 'critica',
        category: 'Walkthrough / Gatilho',
        topicTitle: '1. Abertura de Requisição e Canal de Entrada',
        topicSummary: 'Mapeamento de como surge a demanda de compra na área solicitante, por qual módulo/portal é formalizada e se existem solicitações paralelas fora do sistema.',
        text: 'Para começarmos o walkthrough: o que dispara uma necessidade de compra e por qual sistema ou tela o solicitante abre a requisição?',
        rationale: 'Mapear o gatilho do processo (Input), identificar sistemas utilizados e se existem solicitações informais (e-mail/WhatsApp).',
        screenTitle: 'Tela de Abertura de Requisição / Pedido no ERP',
        screenScript: 'Pode compartilhar a tela mostrando um pedido recente desde a requisição original até a aprovação?',
        ipeTip: 'IPE: Capturar número do pedido, usuário solicitante, data/hora e log de aprovação.',
        asked: false
      },
      {
        id: 'q-p2p-2',
        priority: 'critica',
        category: 'Alçada & Controle Automático',
        topicTitle: '2. Trava de Alçada e Edição Pós-Aprovação',
        topicSummary: 'Verificação se a tabela de alçadas no ERP é preventiva e se reinicia o workflow caso preço, quantidade ou condição de pagamento sejam alterados após aprovação.',
        text: 'Depois que o pedido de compra já foi aprovado pela alçada competente, se o comprador alterar o valor, quantidade ou condição de pagamento, o sistema exige nova aprovação automaticamente ou permite seguir?',
        rationale: 'Testar o desenho (TOD) do controle preventivo de workflow de aprovação contra modificações pós-aprovação.',
        screenTitle: 'Estratégia de Liberação e Histórico do Workflow',
        screenScript: 'Pode abrir a aba de estratégia de liberação / workflow de um pedido aprovado para vermos o log de aprovadores?',
        ipeTip: 'IPE: Verificar parâmetros da tabela de alçada vigente e trava contra edição pós-liberação.',
        asked: false
      },
      {
        id: 'q-p2p-3',
        priority: 'alta',
        category: 'Segregação de Funções (SoD)',
        topicTitle: '3. Cadastro de Fornecedores e Dados Bancários',
        topicSummary: 'Análise de conflito de funções entre quem mantém dados mestres/bancários de fornecedores e quem emite ou aprova pedidos de compra.',
        text: 'Quem tem permissão no sistema para cadastrar ou alterar dados bancários de fornecedores? Essa mesma equipe consegue emitir ou aprovar pedidos de compra?',
        rationale: 'Avaliar risco crítico de fraude por conflito de Segregação de Funções (SoD) entre Cadastro de Fornecedores e Compras/Pagamentos.',
        screenTitle: 'Transação de Dados Mestres de Fornecedores e Bloqueio Three-Way Match',
        screenScript: 'Pode mostrar onde o sistema valida a divergência entre Pedido, Recebimento Físico e Nota Fiscal (Three-Way Match)?',
        ipeTip: 'IPE: Confirmar se a tolerância é parametrizada no sistema e quem possui perfil para liberar bloqueios.',
        asked: false
      },
      {
        id: 'q-p2p-4',
        priority: 'alta',
        category: 'Exceção / Bypass',
        topicTitle: '4. Compras Emergenciais e Pagamentos sem Pedido',
        topicSummary: 'Identificação de fluxos de urgência, lançamentos diretos de Nota Fiscal no financeiro sem pedido de compra e controles detectivos de revisão.',
        riskAlert: 'Ponto de atenção: Compras sem pedido são o principal vetor de contorno (bypass) das alçadas.',
        text: 'Como funcionam as compras emergenciais ou pagamentos sem pedido de compra (lançamento direto de NF)? Quem autoriza essa exceção e como ela é monitorada?',
        rationale: 'Identificar canais de bypass dos controles padrão de cotação e alçada.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-p2p-1',
        title: 'Tela de Workflow e Tabela de Alçadas no ERP',
        script: 'Você pode compartilhar sua tela e abrir um pedido de compra recente para vermos a aba de estratégia de liberação/histórico de aprovadores com data e hora?',
        ipeTip: 'IPE / Evidência: Capturar o número do pedido, status, log de usuários aprovadores, data/hora e parâmetros da tabela de alçada vigente.',
        status: 'pending'
      },
      {
        id: 's-p2p-2',
        title: 'Bloqueio de Three-Way Match (Pedido x Entrada Física x Nota Fiscal)',
        script: 'Pode mostrar na tela onde o sistema valida a divergência entre o valor/quantidade do Pedido de Compra e a Nota Fiscal recebida (tolerância configurada)?',
        ipeTip: 'IPE / Evidência: Verificar se a trava é automática (parametrizada no sistema) e quem possui perfil para liberar bloqueios de preço/quantidade.',
        status: 'pending'
      }
    ],
    risks: [
      {
        id: 'r-p2p-1',
        severity: 'Alto',
        title: 'Risco de Bypass em Compras Emergenciais / Sem Pedido',
        description: 'Pagamentos realizados diretamente via solicitação financeira sem passar pelo fluxo de cotação e aprovação de alçada no ERP.',
        recommendation: 'Implementar bloqueio sistêmico para lançamentos sem pedido (exceto naturezas pré-aprovadas) e relatório mensal detectivo de exceções.'
      }
    ],
    controls: [
      {
        id: 'c-p2p-1',
        name: 'Aprovação Eletrônica de Pedido por Alçada no ERP',
        type: 'Preventivo',
        nature: 'Automático',
        frequency: 'Por transação',
        status: 'Em Teste (Walkthrough)'
      }
    ]
  },

  iam: {
    topic: 'Gestão de Acessos, Perfis, Senhas e Segregação de Funções (ITGC / IAM)',
    methodology: 'itgc_sod',
    scope: 'Active Directory, ERP Corporativo, Portal de Chamados (ITSM) e Contas Privilegiadas',
    coachingTip: 'Foque nos 4 pilares de ITGC de Acessos: (1) Concessão com aprovação formal; (2) Revogação imediata de desligados; (3) Revisão periódica de acessos; (4) Contas privilegiadas.',
    questions: [
      {
        id: 'q-iam-1',
        priority: 'critica',
        category: 'Concessão & Aprovação',
        topicTitle: '1. Concessão de Acessos e Validação de Conflitos SoD',
        topicSummary: 'Fluxo de solicitação de novos perfis ou mudança de função e verificação prévia de conflitos de Segregação de Funções.',
        text: 'Quando um colaborador precisa de um novo perfil de acesso ou mudança de cargo, como o pedido é feito e o sistema valida matriz de Segregação de Funções (SoD) antes de liberar?',
        rationale: 'Testar controle preventivo de concessão de acessos e avaliação prévia de conflitos SoD.',
        screenTitle: 'Chamado Recente de Concessão de Acesso no ITSM',
        screenScript: 'Pode mostrar na tela um chamado recente de liberação de acesso e a aprovação do gestor/owner do sistema?',
        ipeTip: 'IPE: Verificar data da aprovação vs. data da concessão no sistema e perfil atribuído.',
        asked: false
      },
      {
        id: 'q-iam-2',
        priority: 'critica',
        category: 'Desligamento / Revogação',
        topicTitle: '2. Revogação Tempestiva de Colaboradores Desligados',
        topicSummary: 'Comunicação entre RH e TI no desligamento de funcionários e terceiros para bloqueio imediato no Active Directory e ERP.',
        riskAlert: 'Risco de acessos ativos de ex-colaboradores caso o processo dependa de chamado manual.',
        text: 'No momento em que o RH processa uma demissão, o bloqueio no Active Directory e no ERP é automático e imediato ou depende de abertura manual de chamado?',
        rationale: 'Risco crítico de ex-colaboradores manterem acesso ativo a sistemas corporativos após o desligamento.',
        screenTitle: 'Base de Usuários Ativos vs. Lista de Desligados do RH',
        screenScript: 'Pode abrir o painel de usuários ativos no sistema e comparar a data de desligamento de um ex-colaborador com a data do bloqueio?',
        ipeTip: 'IPE: Solicitar extração completa de usuários ativos com parâmetros, data/hora e total de linhas.',
        asked: false
      },
      {
        id: 'q-iam-3',
        priority: 'alta',
        category: 'Revisão Periódica & Contas Privilegiadas',
        topicTitle: '3. Revisão Periódica de Perfis e Superusuários',
        topicSummary: 'Ciclo de recertificação de acessos pelos gestores e monitoramento de contas administrativas (Admin/Firefighter).',
        text: 'Existe uma revisão periódica formal dos usuários ativos e dos perfis de administrador (SuperUser/Firefighter)? Quem revisa e o que acontece se o gestor não responder?',
        rationale: 'Avaliar controle detectivo de recertificação de acessos e monitoramento de logs de superusuários.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-iam-1',
        title: 'Listagem de Usuários Ativos no Sistema vs. Lista de Desligados do RH',
        script: 'Pode compartilhar a tela do painel de usuários ativos no sistema e também abrir um chamado recente de desligamento para compararmos a data de saída com a data de bloqueio?',
        ipeTip: 'IPE / Evidência: Solicitar extração completa da base de usuários ativos mostrando filtro aplicado, data/hora de extração e total de linhas.',
        status: 'pending'
      }
    ],
    risks: [
      {
        id: 'r-iam-1',
        severity: 'Alto',
        title: 'Revogação Tardia de Acessos de Terceiros e Desligados',
        description: 'Caso o fluxo dependa de comunicação manual, contas de ex-funcionários ou prestadores podem permanecer ativas.',
        recommendation: 'Automatizar gatilho de bloqueio via integração RH -> AD/IAM no dia do desligamento e instituir rotina de inatividade (ex: 30 dias).'
      }
    ],
    controls: [
      {
        id: 'c-iam-1',
        name: 'Bloqueio de Acesso de Colaboradores Desligados',
        type: 'Preventivo',
        nature: 'Híbrido / Dependentes de TI',
        frequency: 'Por evento',
        status: 'Em Teste (Walkthrough)'
      }
    ]
  },

  o2c: {
    topic: 'Vendas, Análise de Crédito, Faturamento e Recebimento (Order-to-Cash)',
    methodology: 'walkthrough_coso',
    scope: 'CRM, ERP Faturamento, Gestão de Limite de Crédito, Descontos Comerciais e Contas a Receber',
    coachingTip: 'Explore: (1) Aprovação de descontos fora da tabela; (2) Liberação manual de pedidos bloqueados por limite de crédito; (3) Emissão de notas de crédito e baixas manuais.',
    questions: [
      {
        id: 'q-o2c-1',
        priority: 'critica',
        category: 'Política Comercial & Preços',
        topicTitle: '1. Tabela de Preços e Alçada de Descontos Comerciais',
        topicSummary: 'Regras sistêmicas para inserção de preços no pedido de venda e bloqueio de descontos acima da política comercial.',
        text: 'O vendedor consegue digitar manualmente o preço ou percentual de desconto no pedido, ou o sistema puxa uma tabela fixa e bloqueia qualquer desconto acima da alçada?',
        rationale: 'Verificar risco de erosão de margem ou descontos não autorizados na criação do pedido.',
        asked: false
      },
      {
        id: 'q-o2c-2',
        priority: 'critica',
        category: 'Limite de Crédito',
        topicTitle: '2. Bloqueio de Faturamento por Limite de Crédito / Inadimplência',
        topicSummary: 'Funcionamento da trava automática de crédito no faturamento e perfis autorizados a liberar exceções.',
        text: 'Quando um cliente está inadimplente ou estoura o limite de crédito, o sistema trava o faturamento automaticamente? Quem tem acesso para liberar esse bloqueio?',
        rationale: 'Testar efetividade do bloqueio automático de crédito e segregação entre área Comercial e Crédito/Cobrança.',
        screenTitle: 'Tela de Bloqueio de Crédito e Log de Liberação',
        screenScript: 'Pode abrir na tela um pedido recente que caiu na trava de crédito para vermos quem aprovou a liberação e a evidência anexada?',
        ipeTip: 'IPE: Verificar log de usuário/data/hora na transação de liberação de crédito.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-o2c-1',
        title: 'Tela de Bloqueio de Crédito e Log de Liberação Manual',
        script: 'Pode abrir na tela um caso recente de pedido que caiu na trava de crédito para vermos quem aprovou a liberação e qual justificativa/evidência ficou anexada?',
        ipeTip: 'IPE / Evidência: Verificar log de usuário/data/hora na transação de liberação de crédito e parâmetros de alçada.',
        status: 'pending'
      }
    ],
    risks: [],
    controls: []
  },

  r2r: {
    topic: 'Fechamento Contábil, Conciliações e Lançamentos Manuais (Record-to-Report)',
    methodology: 'sox_ipe',
    scope: 'ERP Contábil, Planilhas de Conciliação, Lançamentos Manuais (Journal Entries) e Fechamento',
    coachingTip: 'Foque nos riscos clássicos de R2R/SOX: (1) Lançamentos contábeis manuais (quem prepara vs. quem aprova); (2) Conciliações em Excel; (3) Trava de período contábil.',
    questions: [
      {
        id: 'q-r2r-1',
        priority: 'critica',
        category: 'Lançamentos Manuais (JE)',
        topicTitle: '1. Alçada e Segregação em Lançamentos Contábeis Manuais',
        topicSummary: 'Validação de workflow de aprovação no razão geral (GL) para evitar contabilizações manuais sem revisão independente.',
        text: 'Para lançamentos contábeis manuais, qualquer analista consegue contabilizar direto no razão geral (GL) ou o sistema exige que um revisor/gestor aprove antes de efetivar?',
        rationale: 'Avaliar segregação de funções (Preparador x Aprovador) em lançamentos manuais (risco de Management Override).',
        asked: false
      },
      {
        id: 'q-r2r-2',
        priority: 'critica',
        category: 'Conciliações & IPE',
        topicTitle: '2. Conciliações Contábeis e Integridade do Balancete (IPE)',
        topicSummary: 'Batimento entre relatórios auxiliares, planilhas de conciliação e o saldo fechado no balancete oficial.',
        text: 'Como é garantido que o saldo contábil na planilha de conciliação bate exatamente com o balancete oficial fechado após o encerramento do período?',
        rationale: 'Validar integridade e precisão da informação (IPE) e tratamento de partidas antigas em aberto.',
        screenTitle: 'Trava de Período Contábil e Papel de Trabalho de Conciliação',
        screenScript: 'Pode mostrar a transação onde o período contábil é fechado e abrir uma conciliação do último mês com a evidência de revisão?',
        ipeTip: 'IPE: Verificar se relatórios auxiliares anexados possuem data/hora de extração e parâmetros visíveis.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-r2r-1',
        title: 'Trava de Período Contábil e Log de Lançamento Manual',
        script: 'Pode mostrar na tela a transação onde o período contábil é fechado e abrir uma conciliação do último mês para vermos a evidência de revisão e aprovação?',
        ipeTip: 'IPE / Evidência: Verificar se os relatórios auxiliares anexados à conciliação possuem data/hora de extração e parâmetros visíveis.',
        status: 'pending'
      }
    ],
    risks: [],
    controls: []
  },

  hr: {
    topic: 'Folha de Pagamento, Admissão, Férias, Horas Extras e Desligamento (RH)',
    methodology: 'walkthrough_coso',
    scope: 'Sistema de Folha (ADP/TOTVS/Senior), Ponto Eletrônico, Benefícios e Pagamento Bancário',
    coachingTip: 'Verifique: (1) Segregação entre cadastro salarial e geração do arquivo bancário; (2) Revisão analítica da prévia da folha; (3) Proteção do arquivo CNAB.',
    questions: [
      {
        id: 'q-hr-1',
        priority: 'critica',
        category: 'Integridade da Folha & CNAB',
        topicTitle: '1. Segurança do Arquivo Bancário de Pagamento da Folha (CNAB)',
        topicSummary: 'Fluxo de geração e transmissão da remessa bancária da folha e proteção contra edição manual do arquivo texto.',
        text: 'Após o fechamento da folha, quando o arquivo de pagamento é gerado para o banco, ele vai via integração criptografada direta ou é baixado em uma pasta onde alguém poderia editar o TXT/CNAB?',
        rationale: 'Avaliar risco crítico de manipulação de conta bancária ou valores no arquivo de remessa de pagamento da folha.',
        asked: false
      },
      {
        id: 'q-hr-2',
        priority: 'alta',
        category: 'Conferência Detectiva',
        topicTitle: '2. Revisão Analítica da Folha e Exclusão de Desligados',
        topicSummary: 'Conferência mensal de variações salariais, horas extras e exclusão de demitidos antes da aprovação financeira.',
        text: 'Qual conferência é feita antes de liberar o pagamento da folha para garantir que funcionários desligados no mês não recebam salário indevido ou que não haja funcionários fantasmas?',
        rationale: 'Testar desenho do controle detectivo de conciliação analítica de folha (Headcount x Folha Anterior x Desligados).',
        screenTitle: 'Relatório de Críticas / Comparativo Mensal da Folha',
        screenScript: 'Pode mostrar na tela o relatório de conferência da última folha fechada e a aprovação formal da gerência?',
        ipeTip: 'IPE: Confirmar totalizador da folha vs. valor aprovado no Internet Banking / Contas a Pagar.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-hr-1',
        title: 'Relatório de Críticas / Comparativo Mensal da Folha',
        script: 'Pode mostrar na tela o relatório de conferência/variação da última folha fechada e a aprovação formal da gerência antes do envio ao banco?',
        ipeTip: 'IPE / Evidência: Confirmar totalizador da folha vs. valor aprovado no Internet Banking / Contas a Pagar.',
        status: 'pending'
      }
    ],
    risks: [],
    controls: []
  },

  inv: {
    topic: 'Estoque, Recebimento Físico, Inventário Rotativo e Baixas/Ajustes',
    methodology: 'walkthrough_coso',
    scope: 'WMS / ERP Estoque, Almoxarifado, Contagem Cíclica e Baixas por Perda/Obsolescência',
    coachingTip: 'Investigue: (1) Recebimento cego no almoxarifado; (2) Aprovação de ajustes de inventário/baixas de perda; (3) Segregação entre guarda física e ajuste sistêmico.',
    questions: [
      {
        id: 'q-inv-1',
        priority: 'critica',
        category: 'Ajustes de Estoque & SoD',
        topicTitle: '1. Aprovação de Ajustes de Inventário e Baixas de Estoque',
        topicSummary: 'Segregação entre o responsável pela guarda física do almoxarifado e quem aprova baixas ou ajustes de diferenças no ERP.',
        text: 'Quando é identificada uma diferença entre o estoque físico e o sistema no inventário, quem tem permissão para lançar o ajuste (baixa/entrada) e qual aprovação é exigida?',
        rationale: 'Evitar que o próprio responsável pela guarda física encubra desvios ou perdas fazendo ajustes diretos no sistema.',
        screenTitle: 'Histórico de Movimentações de Ajuste de Inventário no ERP',
        screenScript: 'Pode abrir na tela os lançamentos de ajuste de estoque do último mês para vermos os códigos de movimentação e quem aprovou?',
        ipeTip: 'IPE: Extrair razão de movimentações por código de ajuste/perda.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-inv-1',
        title: 'Histórico de Movimentações de Ajuste de Inventário no ERP',
        script: 'Pode abrir na tela os lançamentos de ajuste de estoque do último mês para vermos os códigos de movimentação utilizados e quem aprovou?',
        ipeTip: 'IPE / Evidência: Extrair razão de movimentações por tipo de movimento de ajuste/perda.',
        status: 'pending'
      }
    ],
    risks: [],
    controls: []
  },

  fraud: {
    topic: 'Prevenção a Fraudes, Conflito de Interesses e Pagamentos Críticos',
    methodology: 'operational_risk',
    scope: 'Due Diligence de Fornecedores, Reembolsos de Despesas, Brindes, Contratos e Pagamentos',
    coachingTip: 'Observe red flags: urgência recorrente para pular etapas, fornecedores sem contrato formal, reembolsos sem comprovante fiscal ou fracionamento de compras (split).',
    questions: [
      {
        id: 'q-frd-1',
        priority: 'critica',
        category: 'Fracionamento de Alçada (Split)',
        topicTitle: '1. Prevenção ao Fracionamento de Compras (PO Splitting)',
        topicSummary: 'Monitoramento ou trava contra divisão de compras em múltiplos pedidos menores para escapar da alçada da diretoria.',
        text: 'O sistema possui algum alerta ou bloqueio caso um solicitante divida uma compra grande em vários pedidos menores para ficar abaixo da alçada da diretoria?',
        rationale: 'Testar controle contra fracionamento de compras (Purchase Order Splitting) para burlar alçadas de aprovação.',
        screenTitle: 'Consulta de Due Diligence / Cruzamento Sócio x Colaborador',
        screenScript: 'Pode mostrar na tela como é feita a consulta de Background Check / Due Diligence antes de ativar um fornecedor crítico?',
        ipeTip: 'IPE: Verificar retenção dos certificados/consultas de compliance anexados ao cadastro.',
        asked: false
      }
    ],
    screenRequests: [
      {
        id: 's-frd-1',
        title: 'Validação de Due Diligence / Cruzamento Sócio x Colaborador',
        script: 'Pode mostrar na tela como é feita a consulta de Background Check / Due Diligence antes de ativar um fornecedor crítico no cadastro?',
        ipeTip: 'IPE / Evidência: Verificar retenção dos certificados/consultas de compliance anexados ao cadastro.',
        status: 'pending'
      }
    ],
    risks: [],
    controls: []
  }
};

// Checklist padrão de 8 Pilares de Mapeamento / Walkthrough (Metodologia IIA / COSO / SOX)
function getDefaultChecklist() {
  return [
    { id: 'chk-1', title: '1. Gatilho, Entradas e Início do Processo', hint: 'Como o processo começa, quem solicita e por qual canal/sistema', covered: false },
    { id: 'chk-2', title: '2. Sistemas, Telas e Integrações (ITGC)', hint: 'Quais sistemas são usados, se há interfaces automáticas ou digitação manual', covered: false },
    { id: 'chk-3', title: '3. Regras de Negócio, Alçadas e Aprovações', hint: 'Quem aprova, limites financeiros e se a trava é sistêmica ou manual', covered: false },
    { id: 'chk-4', title: '4. Segregação de Funções (SoD) e Perfis de Acesso', hint: 'Quem executa vs. quem aprova/cadastra/concilia', covered: false },
    { id: 'chk-5', title: '5. Tratamento de Exceções, Urgências e Estornos', hint: 'O que acontece fora do fluxo padrão (urgências, erros, cancelamentos)', covered: false },
    { id: 'chk-6', title: '6. Controles Preventivos e Detectivos (COSO)', hint: 'Travas automáticas do sistema + revisões/conciliações posteriores', covered: false },
    { id: 'chk-7', title: '7. Evidências, Logs e Relatórios (IPE / Retenção)', hint: 'Onde fica o rastro de auditoria (log) e como os relatórios são extraídos', covered: false },
    { id: 'chk-8', title: '8. Dores da Área, Falhas Conhecidas e Indicadores', hint: 'Gargalos, riscos já percebidos pelo gestor e KPIs monitorados', covered: false }
  ];
}

// Cenários realistas para o botão "🎭 Simular Fala da Reunião" (para testes rápidos e demonstração)
const SIMULATION_SCENARIOS = [
  {
    speaker: 'Entrevistado (Auditado)',
    text: 'Então, normalmente o solicitante abre o pedido no ERP, mas quando é uma compra urgente da operação, o diretor manda um "de acordo" pelo WhatsApp ou e-mail mesmo, a gente já libera o pagamento no financeiro e depois regulariza o pedido no sistema na semana seguinte.'
  },
  {
    speaker: 'Entrevistado (Auditado)',
    text: 'Para cadastrar um fornecedor novo ou alterar a conta bancária dele, a nossa própria equipe de compras faz direto na tela do ERP porque é mais rápido. Não tem uma aprovação separada no sistema, mas a gente confere os dados que vêm no corpo do e-mail do fornecedor.'
  },
  {
    speaker: 'Entrevistado (Auditado)',
    text: 'No final do mês eu baixo o relatório de todos os pagamentos em Excel, filtro manualmente as contas que quero conciliar, apago as linhas de estorno para limpar a base e salvo na pasta da rede. Como sou eu mesmo que faço há 5 anos, ninguém mais precisa revisar essa planilha.'
  },
  {
    speaker: 'Entrevistado (Auditado)',
    text: 'Quando o analista sai de férias ou tem muito volume, a gente usa um usuário compartilhado chamado "COMPRAS_MASTER" que já tem perfil liberado para aprovar e lançar nota fiscal sem travar na alçada.'
  }
];
