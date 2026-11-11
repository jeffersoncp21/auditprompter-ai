# -*- coding: utf-8 -*-
"""
AuditPrompter — Gerador Corporativo de Documentos de Auditoria Interna (.docx e .xlsx)
Alinhado às Normas Globais de Auditoria Interna (IIA), COSO ICIF, SOX / PCAOB (IPE) e Metodologia de Walkthrough (TOD).
"""
import sys
import json
from datetime import datetime

import docx
from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.enum.section import WD_ORIENT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation


# ---------------------------------------------------------------------------
# Utilitários XML para Word (python-docx)
# ---------------------------------------------------------------------------
def set_cell_bg(cell, hex_color):
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>')
    cell._tc.get_or_add_tcPr().append(shading)


def set_cell_margins(cell, top=100, bottom=100, left=140, right=140):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('top', top), ('bottom', bottom), ('left', left), ('right', right)]:
        node = OxmlElement(f'w:{m}')
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)


def set_table_borders(table, color="CBD5E1", sz="4", val="single"):
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'<w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'<w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'<w:insideH w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'<w:left w:val="none"/>'
        f'<w:right w:val="none"/>'
        f'<w:insideV w:val="{val}" w:sz="{sz}" w:space="0" w:color="E2E8F0"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)


def add_callout_box(doc, title, paragraphs_list, bg_hex="F8FAFC", border_hex="1E3A8A"):
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = False
    cell = tbl.cell(0, 0)
    set_cell_bg(cell, bg_hex)
    set_cell_margins(cell, top=140, bottom=140, left=200, right=180)
    tcPr = cell._tc.get_or_add_tcPr()
    borders = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>'
        f'<w:left w:val="single" w:sz="24" w:space="0" w:color="{border_hex}"/>'
        f'<w:top w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>'
        f'<w:right w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>'
        f'<w:bottom w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>'
        f'</w:tcBorders>'
    )
    tcPr.append(borders)

    p0 = cell.paragraphs[0]
    p0.paragraph_format.space_before = Pt(0)
    p0.paragraph_format.space_after = Pt(4)
    r_title = p0.add_run(title)
    r_title.bold = True
    r_title.font.name = 'Segoe UI'
    r_title.font.size = Pt(9.5)
    r_title.font.color.rgb = RGBColor.from_string(border_hex)

    for idx, text in enumerate(paragraphs_list):
        p = cell.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2 if idx < len(paragraphs_list) - 1 else 0)
        p.paragraph_format.line_spacing = 1.18
        r = p.add_run(text)
        r.font.name = 'Segoe UI'
        r.font.size = Pt(8.8)
        r.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)

    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(6)


def add_section_heading(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text)
    r.bold = True
    r.font.name = 'Segoe UI'
    r.font.size = Pt(11.5)
    r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
    pBdr = parse_xml(
        f'<w:pBdr {nsdecls("w")}>'
        f'<w:bottom w:val="single" w:sz="8" w:space="3" w:color="CBD5E1"/>'
        f'</w:pBdr>'
    )
    p._p.get_or_add_pPr().append(pBdr)
    return p


def configure_doc_styles(doc, landscape=False):
    section = doc.sections[0]
    if landscape:
        section.orientation = WD_ORIENT.LANDSCAPE
        section.page_width = Cm(29.7)
        section.page_height = Cm(21.0)
    else:
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)

    section.top_margin = Cm(1.6)
    section.bottom_margin = Cm(1.6)
    section.left_margin = Cm(1.7)
    section.right_margin = Cm(1.7)

    normal = doc.styles['Normal']
    normal.font.name = 'Segoe UI'
    normal.font.size = Pt(9.5)
    normal.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)


def add_header_banner(doc, subtitle_tag, main_title, ref_code):
    tbl = doc.add_table(rows=1, cols=2)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    c0, c1 = tbl.cell(0, 0), tbl.cell(0, 1)
    set_cell_bg(c0, "0F172A")
    set_cell_bg(c1, "0F172A")
    set_cell_margins(c0, top=160, bottom=160, left=200, right=120)
    set_cell_margins(c1, top=160, bottom=160, left=120, right=200)

    p0 = c0.paragraphs[0]
    p0.paragraph_format.space_after = Pt(2)
    r_sub = p0.add_run(subtitle_tag.upper())
    r_sub.font.name = 'Segoe UI'
    r_sub.font.size = Pt(8)
    r_sub.bold = True
    r_sub.font.color.rgb = RGBColor(0x93, 0xC5, 0xFD)

    p1 = c0.add_paragraph()
    p1.paragraph_format.space_after = Pt(0)
    r_main = p1.add_run(main_title)
    r_main.font.name = 'Segoe UI'
    r_main.font.size = Pt(14)
    r_main.bold = True
    r_main.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    p_ref = c1.paragraphs[0]
    p_ref.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    c1.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    r_ref = p_ref.add_run(f"REF: {ref_code}\nCONFIDENCIAL — USO INTERNO")
    r_ref.font.name = 'Segoe UI'
    r_ref.font.size = Pt(8.5)
    r_ref.bold = True
    r_ref.font.color.rgb = RGBColor(0xE2, 0xE8, 0xF0)

    sp = doc.add_paragraph()
    sp.paragraph_format.space_after = Pt(4)


def add_metadata_grid(doc, pairs):
    """pairs: lista de tuplas (label, valor), renderizada em 2 colunas (4 células por linha)."""
    rows_needed = (len(pairs) + 1) // 2
    tbl = doc.add_table(rows=rows_needed, cols=4)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(tbl, color="CBD5E1", sz="4")

    for r_idx in range(rows_needed):
        for pair_offset in range(2):
            idx = r_idx * 2 + pair_offset
            lbl_cell = tbl.cell(r_idx, pair_offset * 2)
            val_cell = tbl.cell(r_idx, pair_offset * 2 + 1)
            set_cell_bg(lbl_cell, "F1F5F9")
            set_cell_bg(val_cell, "FFFFFF")
            set_cell_margins(lbl_cell, top=75, bottom=75, left=110, right=90)
            set_cell_margins(val_cell, top=75, bottom=75, left=110, right=110)

            if idx < len(pairs):
                label, value = pairs[idx]
                pl = lbl_cell.paragraphs[0]
                pl.paragraph_format.space_after = Pt(0)
                rl = pl.add_run(label)
                rl.bold = True
                rl.font.size = Pt(8.3)
                rl.font.color.rgb = RGBColor(0x33, 0x41, 0x55)

                pv = val_cell.paragraphs[0]
                pv.paragraph_format.space_after = Pt(0)
                rv = pv.add_run(str(value or "—"))
                rv.font.size = Pt(8.8)
                rv.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)


def style_header_row(row, headers, col_widths_cm=None):
    trPr = row._tr.get_or_add_trPr()
    trPr.append(parse_xml(f'<w:tblHeader {nsdecls("w")}/>'))
    for i, text in enumerate(headers):
        cell = row.cells[i]
        set_cell_bg(cell, "0F172A")
        set_cell_margins(cell, top=90, bottom=90, left=100, right=100)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        if col_widths_cm and i < len(col_widths_cm):
            cell.width = Cm(col_widths_cm[i])
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        r = p.add_run(text)
        r.bold = True
        r.font.name = 'Segoe UI'
        r.font.size = Pt(8.2)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)


# ---------------------------------------------------------------------------
# 1. CARTA DE SOLICITAÇÃO DE DOCUMENTOS E EVIDÊNCIAS (PBC / RFI) — .DOCX
# ---------------------------------------------------------------------------
def build_pbc_letter_docx(data, out_path):
    doc = Document()
    configure_doc_styles(doc, landscape=True)

    meta = data.get("pbcMeta", {})
    ref_code = meta.get("refCode") or f"RFI-{datetime.now().strftime('%Y%m%d')}-01"
    topic = data.get("topic") or "Processo em Auditoria"
    scope = data.get("scope") or "Conforme escopo do programa de auditoria"
    methodology = data.get("methodologyLabel") or "Walkthrough (TOD) — Normas Globais IIA / COSO / IPE"

    add_header_banner(
        doc,
        "Auditoria Interna & Controles Internos • Requisição Formal (PBC / RFI)",
        "Carta de Solicitação de Documentos, Bases e Evidências",
        ref_code
    )

    add_metadata_grid(doc, [
        ("Processo / Escopo:", topic),
        ("Código de Referência:", ref_code),
        ("Área / Sistemas:", scope),
        ("Fase Metodológica:", meta.get("auditPhase") or "Walkthrough & Teste de Desenho (TOD)"),
        ("Destinatário / Ponto Focal:", meta.get("recipient") or "[Gestor / Ponto Focal da Área]"),
        ("Auditor(es) Responsável(is):", meta.get("auditorName") or "[Equipe de Auditoria Interna]"),
        ("Período-Base (População):", meta.get("populationPeriod") or "[Conforme especificado por item]"),
        ("Prazo Limite (SLA):", meta.get("slaDate") or "[5 dias úteis]"),
        ("Canal Seguro de Entrega:", meta.get("deliveryChannel") or "Pasta Segura no SharePoint / Portal de Auditoria"),
        ("Data de Emissão:", meta.get("issueDate") or datetime.now().strftime("%d/%m/%Y"))
    ])

    # 1. Contextualização e Escopo Metodológico
    add_section_heading(doc, "1. Contextualização, Objetivo e Escopo da Solicitação")
    intro_text = meta.get("introText") or (
        f"Prezado(a) {meta.get('recipient') or 'Gestor(a)'},\n\n"
        f"Em continuidade aos trabalhos de Auditoria Interna referentes ao mapeamento e avaliação de controles internos do processo \"{topic}\", "
        f"e em conformidade com as Normas Globais de Auditoria Interna (IIA) e diretrizes de avaliação de desenho e efetividade (COSO ICIF / SOX), "
        f"relacionamos a seguir os documentos, relatórios sistêmicos, bases de dados e evidências operacionais necessários para a conclusão do Walkthrough (Test of Design — TOD) e planejamento dos testes substantivos/analíticos."
    )
    for para in intro_text.split("\n"):
        if para.strip():
            p = doc.add_paragraph(para.strip())
            p.paragraph_format.space_after = Pt(5)
            p.paragraph_format.line_spacing = 1.2

    # 2. Tabela Consolidada PBC
    items = data.get("pbcItems", [])
    add_section_heading(doc, f"2. Relação Estruturada de Documentos e Evidências Requeridas ({len(items)} itens)")

    headers = [
        "Cód.",
        "Categoria",
        "Prioridade",
        "Documento / Base / Evidência Solicitada",
        "Objetivo de Auditoria / Risco Mitigado",
        "Critérios de Extração & Requisitos de IPE",
        "Formato Aceito",
        "Ponto Focal",
        "Prazo"
    ]
    widths = [1.5, 3.0, 2.0, 5.8, 4.4, 5.6, 2.3, 2.2, 1.8]

    tbl = doc.add_table(rows=1, cols=len(headers))
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(tbl)
    style_header_row(tbl.rows[0], headers, widths)

    if not items:
        row = tbl.add_row()
        cell = row.cells[0]
        for c in row.cells[1:]:
            cell.merge(c)
        cell.paragraphs[0].add_run("Nenhum item PBC cadastrado na sessão.")
    else:
        for idx, it in enumerate(items):
            row = tbl.add_row()
            bg = "FFFFFF" if idx % 2 == 0 else "F8FAFC"
            prio = str(it.get("priority") or "Alta")
            vals = [
                it.get("code") or f"PBC-{idx+1:02d}",
                it.get("category") or "Walkthrough / TOD",
                prio,
                it.get("title") or "",
                it.get("purpose") or "Validação de desenho e conformidade do processo (TOD).",
                it.get("detail") or "Apresentar parâmetros de seleção, data/hora e integridade da fonte.",
                it.get("format") or "Original (.xlsx / .pdf / Print integral)",
                it.get("owner") or meta.get("recipient") or "A definir",
                it.get("dueDateFormatted") or meta.get("slaDate") or "A definir"
            ]
            for c_i, val in enumerate(vals):
                c = row.cells[c_i]
                cell_bg = bg
                if c_i == 2:
                    if "crít" in prio.lower() or "alta" in prio.lower():
                        cell_bg = "FEF2F2"
                    elif "méd" in prio.lower():
                        cell_bg = "FFFBEB"
                set_cell_bg(c, cell_bg)
                set_cell_margins(c, top=75, bottom=75, left=85, right=85)
                if c_i < len(widths):
                    c.width = Cm(widths[c_i])
                p = c.paragraphs[0]
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.15
                run = p.add_run(str(val))
                run.font.name = 'Segoe UI'
                run.font.size = Pt(8.1)
                if c_i in (0, 2, 3):
                    run.bold = True
                if c_i == 2 and ("crít" in prio.lower() or "alta" in prio.lower()):
                    run.font.color.rgb = RGBColor(0x99, 0x1B, 0x1B)

    # 3. Esclarecimentos / Pontos em Aberto (se houver)
    open_points = [o for o in data.get("openPoints", []) if o.get("status") == "aberto"]
    if open_points:
        add_section_heading(doc, "3. Esclarecimentos Complementares e Pendências da Entrevista")
        p_op = doc.add_paragraph(
            "Adicionalmente ao envio documental, solicitamos a confirmação formal da área quanto aos pontos abaixo registrados durante a reunião de mapeamento:"
        )
        p_op.paragraph_format.space_after = Pt(4)
        for i, op in enumerate(open_points, 1):
            p = doc.add_paragraph(f"{i}. {op.get('text', '')}")
            p.paragraph_format.left_indent = Cm(0.5)
            p.paragraph_format.space_after = Pt(3)

    # 4. Protocolo Obrigatório de IPE
    sec_num = 4 if open_points else 3
    add_section_heading(doc, f"{sec_num}. Protocolo Metodológico de Evidências Sistêmicas (IPE — Information Produced by the Entity)")
    add_callout_box(
        doc,
        "DIRETRIZES OBRIGATÓRIAS PARA EXTRAÇÃO DE TELAS, RELATÓRIOS E BASES DE DADOS (PADRÃO IIA / SOX / PCAOB)",
        [
            "1. Captura Integral e Origem ( Produção ): As capturas de tela (prints) devem exibir a janela completa, demonstrando o nome do sistema/ambiente produtivo, código da transação ou caminho de acesso (ex.: SAP T-Code), usuário logado e relógio da barra de tarefas (data e hora).",
            "2. Comprovação de Parâmetros / Filtros (Completude): Para relatórios e bases extraídas de ERP/BI, encaminhar o print da tela de parâmetros/filtros aplicados imediatamente antes da execução (empresa/CNPJ, período inicial e final, centros de custo, status), evidenciando que a população está completa.",
            "3. Integridade de Planilhas e Bases Brutas (Exatidão): As extrações em Excel (.xlsx) ou CSV devem ser disponibilizadas em seu formato bruto original exportado do sistema, sem exclusão manual de linhas (ex.: estornos ou cancelamentos) ou colunas. Caso haja conciliação/tratamento manual, manter a aba 'Base_Original' preservada.",
            "4. Totalizadores de Controle (Control Totals): Sempre que aplicável, demonstrar na evidência a contagem total de registros/linhas e o somatório financeiro da base para cruzamento com o razão contábil ou relatório gerencial oficial.",
            "5. Trilha Completa no Walkthrough (1 Amostra Fim-a-Fim): Para itens de Teste de Desenho (TOD), a evidência deve permitir rastrear o mesmo documento do gatilho inicial até a aprovação de alçada (com log de usuário/data/hora) e registro final."
        ],
        bg_hex="F8FAFC",
        border_hex="1E3A8A"
    )

    # 5. Governança, LGPD e Rito de Entrega
    add_section_heading(doc, f"{sec_num + 1}. Governança da Informação, LGPD e Rito de Atendimento")
    closing_lines = [
        f"• Organização dos Arquivos: Pedimos identificar cada arquivo com o código correspondente da tabela (ex.: 'PBC-01_Politica_Compras.pdf', 'PBC-02_Base_SAP.xlsx') e realizar o upload exclusivamente pelo canal seguro indicado ({meta.get('deliveryChannel') or 'Pasta Segura / Portal'}).",
        "• Proteção de Dados (LGPD): Caso alguma base contenha dados pessoais sensíveis além do estritamente necessário ao escopo do teste, alinhar previamente com a equipe de Auditoria Interna para anonimização/mascaramento parcial sem prejuízo da chave de auditoria.",
        "• Limitações Sistêmicas ou Indisponibilidade: Caso algum relatório não possa ser extraído na granularidade solicitada por limitação nativa do sistema, favor sinalizar até metade do prazo para alinharmos procedimento alternativo.",
    ]
    for line in closing_lines:
        p = doc.add_paragraph(line)
        p.paragraph_format.space_after = Pt(3)
        p.paragraph_format.line_spacing = 1.15

    if meta.get("closingNotes"):
        p_extra = doc.add_paragraph(f"Observações adicionais: {meta.get('closingNotes')}")
        p_extra.paragraph_format.space_before = Pt(4)

    doc.save(out_path)


# ---------------------------------------------------------------------------
# 2. PAPEL DE TRABALHO COMPLETO (WALKTHROUGH, ATA, 5W2H & RCM) — .DOCX
# ---------------------------------------------------------------------------
def build_working_paper_docx(data, out_path):
    doc = Document()
    configure_doc_styles(doc, landscape=True)

    ref_code = f"WP-TOD-{datetime.now().strftime('%Y%m%d')}"
    topic = data.get("topic") or "Processo Mapeado"
    add_header_banner(
        doc,
        "Auditoria Interna • Papel de Trabalho de Walkthrough & Matriz de Controles (TOD)",
        f"Papel de Trabalho: {topic}",
        ref_code
    )

    add_metadata_grid(doc, [
        ("Processo Auditado:", topic),
        ("Referência WP:", ref_code),
        ("Escopo e Sistemas:", data.get("scope") or "—"),
        ("Metodologia:", data.get("methodologyLabel") or "Walkthrough COSO / SOX"),
        ("Data da Sessão:", data.get("createdAtFormatted") or datetime.now().strftime("%d/%m/%Y")),
        ("Cobertura Walkthrough:", f"{data.get('coveredCount', 0)}/{data.get('totalChecklist', 8)} pilares metodológicos"),
        ("Participantes:", "; ".join(data.get("participantsList", [])) or "[A confirmar]"),
        ("Resumo Quantitativo:", f"{len(data.get('risks', []))} Riscos | {len(data.get('controls', []))} Controles | {len(data.get('pbcItems', []))} PBCs")
    ])

    # 1. Narrativa Executiva
    add_section_heading(doc, "1. Narrativa Executiva do Walkthrough (Test of Design — TOD)")
    narrative = data.get("narrative") or data.get("coachingTip") or "Narrativa ainda não gerada."
    for para in str(narrative).split("\n"):
        if para.strip():
            p = doc.add_paragraph(para.strip())
            p.paragraph_format.space_after = Pt(5)
            p.paragraph_format.line_spacing = 1.2

    # 2. Ata da Reunião
    minutes = data.get("minutes")
    if minutes:
        add_section_heading(doc, "2. Ata Executiva da Reunião & Encaminhamentos")
        if minutes.get("objetivo"):
            p = doc.add_paragraph()
            r1 = p.add_run("Objetivo: ")
            r1.bold = True
            p.add_run(minutes.get("objetivo"))
        for pt in minutes.get("principaisPontos", []):
            p = doc.add_paragraph(f"• {pt}")
            p.paragraph_format.left_indent = Cm(0.4)
            p.paragraph_format.space_after = Pt(2)
        encs = minutes.get("encaminhamentos", [])
        if encs:
            tbl_e = doc.add_table(rows=1, cols=3)
            set_table_borders(tbl_e)
            style_header_row(tbl_e.rows[0], ["Ação / Encaminhamento", "Responsável", "Prazo"], [16.0, 6.0, 4.3])
            for e in encs:
                row = tbl_e.add_row()
                for i, v in enumerate([e.get("acao", ""), e.get("responsavel", ""), e.get("prazo", "")]):
                    set_cell_margins(row.cells[i], top=65, bottom=65, left=85, right=85)
                    row.cells[i].paragraphs[0].add_run(str(v)).font.size = Pt(8.3)

    # 3. Fluxo 5W2H
    steps = data.get("steps5w2h", [])
    if steps:
        add_section_heading(doc, "3. Mapeamento Estruturado de Etapas do Processo (5W2H)")
        tbl_5 = doc.add_table(rows=1, cols=8)
        set_table_borders(tbl_5)
        style_header_row(tbl_5.rows[0], ["Etapa", "O quê", "Quem", "Quando", "Onde / Sistema", "Por quê", "Como", "Volume"], [3.0, 4.2, 2.8, 2.5, 3.2, 3.5, 4.5, 2.6])
        for idx, st in enumerate(steps):
            row = tbl_5.add_row()
            bg = "FFFFFF" if idx % 2 == 0 else "F8FAFC"
            for i, k in enumerate(["etapa", "oQue", "quem", "quando", "onde", "porQue", "como", "quanto"]):
                set_cell_bg(row.cells[i], bg)
                set_cell_margins(row.cells[i], top=60, bottom=60, left=75, right=75)
                r = row.cells[i].paragraphs[0].add_run(str(st.get(k, "")))
                r.font.size = Pt(8.0)
                if i == 0:
                    r.bold = True

    # 4. Matriz de Riscos e Controles (RCM)
    add_section_heading(doc, "4. Matriz Preliminar de Riscos e Controles (RCM — COSO / SOX)")
    rcm_rows = data.get("rcmRows", [])
    tbl_r = doc.add_table(rows=1, cols=8)
    set_table_borders(tbl_r)
    style_header_row(
        tbl_r.rows[0],
        ["Risco / Gap", "Sev.", "Descrição da Fragilidade", "Controle Mitigante", "Classificação", "Afirmação", "Avaliação TOD", "Recomendação"],
        [4.0, 1.5, 4.5, 4.0, 2.8, 2.4, 2.8, 4.3]
    )
    if not rcm_rows:
        row = tbl_r.add_row()
        row.cells[0].paragraphs[0].add_run("Nenhum risco ou controle registrado.")
    else:
        for idx, item in enumerate(rcm_rows):
            row = tbl_r.add_row()
            bg = "FFFFFF" if idx % 2 == 0 else "F8FAFC"
            sev = item.get("severity", "")
            vals = [
                item.get("riskLabel", ""),
                sev,
                item.get("riskDesc", ""),
                item.get("controlLabel", "SEM CONTROLE"),
                item.get("controlClass", "—"),
                item.get("assertion", "—"),
                item.get("todStatus", "—"),
                item.get("recommendation", "—")
            ]
            for i, v in enumerate(vals):
                c = row.cells[i]
                c_bg = "FEF2F2" if (i == 1 and sev == "Alto") else ("FFFBEB" if (i == 1 and sev == "Médio") else bg)
                set_cell_bg(c, c_bg)
                set_cell_margins(c, top=65, bottom=65, left=75, right=75)
                r = c.paragraphs[0].add_run(str(v))
                r.font.size = Pt(8.0)
                if i in (0, 1):
                    r.bold = True

    # 5. Lista PBC resumida no WP
    pbc_items = data.get("pbcItems", [])
    add_section_heading(doc, f"5. Evidências Solicitadas — PBC ({len(pbc_items)} itens)")
    tbl_p = doc.add_table(rows=1, cols=6)
    set_table_borders(tbl_p)
    style_header_row(tbl_p.rows[0], ["Cód.", "Categoria", "Evidência Solicitada", "Critérios / IPE", "Responsável", "Status / Prazo"], [1.8, 3.5, 6.5, 8.0, 3.2, 3.3])
    for idx, p in enumerate(pbc_items):
        row = tbl_p.add_row()
        bg = "FFFFFF" if idx % 2 == 0 else "F8FAFC"
        vals = [
            p.get("code", ""),
            p.get("category", "Walkthrough / TOD"),
            p.get("title", ""),
            p.get("detail", ""),
            p.get("owner", "A definir"),
            f"{p.get('status', 'Pendente')} ({p.get('dueDateFormatted') or 'A definir'})"
        ]
        for i, v in enumerate(vals):
            set_cell_bg(row.cells[i], bg)
            set_cell_margins(row.cells[i], top=60, bottom=60, left=75, right=75)
            row.cells[i].paragraphs[0].add_run(str(v)).font.size = Pt(8.0)

    # 6. Anexo Opcional: Transcrição
    if data.get("includeTranscript") and data.get("transcript"):
        add_section_heading(doc, "Anexo — Registro Rastreável da Entrevista")
        for t in data.get("transcript", []):
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(2)
            r_id = p.add_run(f"[T{t.get('seq', '')} • {t.get('time', '')}] {t.get('speaker', '')}: ")
            r_id.bold = True
            r_id.font.size = Pt(8.2)
            r_tx = p.add_run(str(t.get("text", "")))
            r_tx.font.size = Pt(8.2)

    doc.save(out_path)


# ---------------------------------------------------------------------------
# 3. PACOTE CORPORATIVO MULTI-ABAS EM EXCEL (PBC TRACKER + RCM + 5W2H) — .XLSX
# ---------------------------------------------------------------------------
def build_audit_workbook_xlsx(data, out_path):
    wb = openpyxl.Workbook()
    meta = data.get("pbcMeta", {})
    ref_code = meta.get("refCode") or f"RFI-{datetime.now().strftime('%Y%m%d')}-01"
    topic = data.get("topic") or "Processo Auditado"

    # Paleta corporativa
    fill_navy = PatternFill("solid", fgColor="0F172A")
    fill_sub = PatternFill("solid", fgColor="1E3A8A")
    fill_zebra = PatternFill("solid", fgColor="F8FAFC")
    fill_label = PatternFill("solid", fgColor="F1F5F9")
    fill_client_hdr = PatternFill("solid", fgColor="065F46")
    fill_red = PatternFill("solid", fgColor="FEE2E2")
    fill_amber = PatternFill("solid", fgColor="FEF3C7")
    fill_green = PatternFill("solid", fgColor="DCFCE7")

    font_banner = Font(name="Segoe UI", size=13, bold=True, color="FFFFFF")
    font_sub = Font(name="Segoe UI", size=9, bold=True, color="93C5FD")
    font_hdr = Font(name="Segoe UI", size=9.5, bold=True, color="FFFFFF")
    font_lbl = Font(name="Segoe UI", size=9, bold=True, color="334155")
    font_cell = Font(name="Segoe UI", size=9.5, color="0F172A")
    font_bold = Font(name="Segoe UI", size=9.5, bold=True, color="0F172A")

    thin = Side(border_style="thin", color="CBD5E1")
    border_all = Border(left=thin, right=thin, top=thin, bottom=thin)
    align_wrap = Alignment(vertical="top", wrap_text=True)
    align_center = Alignment(horizontal="center", vertical="top", wrap_text=True)
    align_hdr = Alignment(horizontal="center", vertical="center", wrap_text=True)

    def setup_banner(ws, title, subtitle, max_col):
        ws.views.sheetView[0].showGridLines = True
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max_col)
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=max_col)
        c1 = ws.cell(1, 1, subtitle.upper())
        c1.fill = fill_navy
        c1.font = font_sub
        c1.alignment = Alignment(vertical="center", indent=1)
        ws.row_dimensions[1].height = 18

        c2 = ws.cell(2, 1, title)
        c2.fill = fill_navy
        c2.font = font_banner
        c2.alignment = Alignment(vertical="center", indent=1)
        ws.row_dimensions[2].height = 28

    # =========================================================================
    # ABA 1: CARTA & CONTROLE PBC (TRACKER PRONTO PARA O AUDITADO)
    # =========================================================================
    ws_pbc = wb.active
    ws_pbc.title = "01_Carta_Controle_PBC"
    setup_banner(
        ws_pbc,
        f"SOLICITAÇÃO DE DOCUMENTOS E EVIDÊNCIAS (PBC / RFI) — {ref_code}",
        "AUDITORIA INTERNA & CONTROLES INTERNOS • TRACKER DE ATENDIMENTO E VALIDAÇÃO DE IPE",
        13
    )

    meta_rows = [
        ("Processo Auditado:", topic, "Código de Referência:", ref_code),
        ("Área / Sistemas:", data.get("scope") or "—", "Fase Metodológica:", meta.get("auditPhase") or "Walkthrough & Teste de Desenho (TOD)"),
        ("Ponto Focal (Área):", meta.get("recipient") or "A definir", "Auditor Responsável:", meta.get("auditorName") or "Auditoria Interna"),
        ("Período-Base:", meta.get("populationPeriod") or "Conforme item", "Prazo Limite (SLA):", meta.get("slaDate") or "A definir"),
        ("Canal de Entrega:", meta.get("deliveryChannel") or "Pasta Segura / Portal", "Data de Emissão:", meta.get("issueDate") or datetime.now().strftime("%d/%m/%Y"))
    ]
    for idx, (l1, v1, l2, v2) in enumerate(meta_rows, start=4):
        ws_pbc.row_dimensions[idx].height = 20
        ws_pbc.cell(idx, 1, l1).font = font_lbl
        ws_pbc.cell(idx, 1).fill = fill_label
        ws_pbc.merge_cells(start_row=idx, start_column=2, end_row=idx, end_column=5)
        ws_pbc.cell(idx, 2, v1).font = font_cell

        ws_pbc.cell(idx, 6, l2).font = font_lbl
        ws_pbc.cell(idx, 6).fill = fill_label
        ws_pbc.merge_cells(start_row=idx, start_column=7, end_row=idx, end_column=13)
        ws_pbc.cell(idx, 7, v2).font = font_bold if idx == 4 else font_cell
        for col_i in range(1, 14):
            ws_pbc.cell(idx, col_i).border = border_all

    # Aviso rápido de IPE na linha 10
    ws_pbc.merge_cells("A10:M10")
    c_ipe = ws_pbc.cell(
        10, 1,
        "REGRA DE OURO DE AUDITORIA (IPE): Para telas e relatórios de sistema, evidenciar SEMPRE: (1) Parâmetros/filtros aplicados antes da extração; "
        "(2) Código da transação/tela, ambiente produtivo e usuário; (3) Data/hora da extração; (4) Bases em Excel em formato bruto original sem exclusão de linhas."
    )
    c_ipe.fill = PatternFill("solid", fgColor="EFF6FF")
    c_ipe.font = Font(name="Segoe UI", size=9, bold=True, color="1E3A8A")
    c_ipe.alignment = Alignment(vertical="center", wrap_text=True)
    ws_pbc.row_dimensions[10].height = 28

    pbc_headers = [
        "Cód.",
        "Categoria Metodológica",
        "Prioridade",
        "Documento / Base / Evidência Solicitada",
        "Objetivo do Teste / Risco Associado",
        "Critérios de Extração & Requisitos de IPE",
        "Formato Esperado",
        "Ponto Focal (Área)",
        "Prazo (SLA)",
        "Status do Atendimento",
        "Data de Envio (Área)",
        "Arquivo / Link Entregue (Área)",
        "Comentários Área / Validação Auditoria"
    ]
    hdr_row = 12
    ws_pbc.row_dimensions[hdr_row].height = 30
    for col_i, h in enumerate(pbc_headers, 1):
        cell = ws_pbc.cell(hdr_row, col_i, h)
        cell.fill = fill_client_hdr if col_i >= 10 else fill_navy
        cell.font = font_hdr
        cell.alignment = align_hdr
        cell.border = border_all

    pbc_items = data.get("pbcItems", [])
    for idx, it in enumerate(pbc_items, start=hdr_row + 1):
        ws_pbc.row_dimensions[idx].height = 44
        zf = fill_zebra if idx % 2 == 1 else PatternFill("solid", fgColor="FFFFFF")
        prio = str(it.get("priority") or "Alta")
        status = str(it.get("status") or "Pendente")
        vals = [
            it.get("code") or f"PBC-{idx - hdr_row:02d}",
            it.get("category") or "Walkthrough / TOD",
            prio,
            it.get("title") or "",
            it.get("purpose") or "Validação de desenho de controle interno (TOD).",
            it.get("detail") or "",
            it.get("format") or "Original (.xlsx / .pdf / Print integral)",
            it.get("owner") or meta.get("recipient") or "",
            it.get("dueDateFormatted") or meta.get("slaDate") or "",
            status,
            "",
            "",
            ""
        ]
        for col_i, v in enumerate(vals, 1):
            c = ws_pbc.cell(idx, col_i, v)
            c.font = font_bold if col_i in (1, 3, 4, 10) else font_cell
            c.fill = zf
            c.border = border_all
            c.alignment = align_center if col_i in (1, 3, 9, 10, 11) else align_wrap
            if col_i == 3:
                if "crít" in prio.lower() or "alta" in prio.lower():
                    c.fill = fill_red
                elif "méd" in prio.lower():
                    c.fill = fill_amber
            if col_i == 10:
                if status == "Validado":
                    c.fill = fill_green
                elif status in ("Recebido", "Solicitado"):
                    c.fill = fill_amber

    last_pbc_row = max(hdr_row + len(pbc_items), hdr_row + 1)
    dv = DataValidation(type="list", formula1='"Pendente,Solicitado,Recebido,Em Análise,Validado,Com Pendência / Reenviar,Não Aplicável"', allow_blank=True)
    ws_pbc.add_data_validation(dv)
    dv.add(f"J{hdr_row+1}:J{last_pbc_row + 15}")

    ws_pbc.freeze_panes = f"A{hdr_row+1}"
    ws_pbc.auto_filter.ref = f"A{hdr_row}:M{last_pbc_row}"
    pbc_widths = [10, 26, 13, 38, 34, 44, 22, 20, 14, 18, 15, 28, 34]
    for i, w in enumerate(pbc_widths, 1):
        ws_pbc.column_dimensions[get_column_letter(i)].width = w

    # =========================================================================
    # ABA 2: PROTOCOLO METODOLÓGICO DE IPE (GUIA PARA O AUDITADO)
    # =========================================================================
    ws_ipe = wb.create_sheet("02_Guia_Evidencias_IPE")
    setup_banner(
        ws_ipe,
        "GUIA PRÁTICO PARA ENTREGA DE EVIDÊNCIAS E EXTRATOS DE SISTEMA (PROTOCOLO IPE)",
        "PADRÃO DE CONFIABILIDADE DA INFORMAÇÃO PRODUZIDA PELA ENTIDADE (IIA / COSO / SOX)",
        3
    )
    ipe_rules = [
        ("1. Captura de Tela Integral (Ambiente e Rastreabilidade)", "Evitar recortes parciais", "Capturar a tela inteira do monitor demonstrando: nome do sistema/ERP, ambiente de Produção, código da transação (ex.: T-Code no SAP), login do usuário e relógio do sistema operacional com data e hora."),
        ("2. Parâmetros e Filtros de Extração (Completude)", "Relatório sem tela de filtro é recusado", "Antes de exportar qualquer listagem ou base (ex.: pedidos, pagamentos, acessos, conciliações), capturar o print da tela de parâmetros de seleção preenchida (empresa/CNPJ, datas início/fim, centros de custo, tipos de movimento)."),
        ("3. Bases Brutas em Excel / CSV (Exatidão e Integridade)", "Não excluir linhas de estorno/cancelamento", "Enviar o arquivo exatamente como exportado pelo sistema. Caso a área realize filtros, exclusões ou análises em cima da base, fazê-lo em uma segunda aba mantendo a aba 'Base_Original' 100% preservada."),
        ("4. Totalizadores de Controle (Control Totals)", "Garantir cruzamento contábil/operacional", "Apresentar ao final do relatório ou no print do sistema a quantidade total de registros (linhas) e o somatório de valores para conciliação com o balancete/razão oficial."),
        ("5. Evidência de Walkthrough Fim-a-Fim (TOD)", "Mesma transação do início ao fim", "Para comprovar o desenho do controle com 1 caso real, apresentar os documentos encadeados da mesma operação: (a) requisição inicial, (b) cotação/análise, (c) log de aprovação pela alçada competente com data/hora, (d) recebimento/NF e (e) liquidação.")
    ]
    ws_ipe.row_dimensions[4].height = 26
    for i, h in enumerate(["Pilar de IPE / Requisito", "Cuidado Crítico", "Como Evidenciar Corretamente"], 1):
        c = ws_ipe.cell(4, i, h)
        c.fill = fill_navy
        c.font = font_hdr
        c.alignment = align_hdr
        c.border = border_all
    for r_i, (p1, p2, p3) in enumerate(ipe_rules, start=5):
        ws_ipe.row_dimensions[r_i].height = 48
        for c_i, val in enumerate([p1, p2, p3], 1):
            c = ws_ipe.cell(r_i, c_i, val)
            c.font = font_bold if c_i == 1 else font_cell
            c.fill = fill_amber if c_i == 2 else (fill_zebra if r_i % 2 == 1 else PatternFill("solid", fgColor="FFFFFF"))
            c.alignment = align_wrap
            c.border = border_all
    for i, w in enumerate([36, 30, 80], 1):
        ws_ipe.column_dimensions[get_column_letter(i)].width = w

    # =========================================================================
    # ABA 3: MATRIZ DE RISCOS E CONTROLES (RCM)
    # =========================================================================
    ws_rcm = wb.create_sheet("03_Matriz_RCM")
    setup_banner(ws_rcm, f"MATRIZ DE RISCOS E CONTROLES (RCM) — {topic}", "AVALIAÇÃO DE DESENHO (WALKTHROUGH / TOD) • COSO ICIF / SOX", 12)
    rcm_headers = ["Cód. Risco", "Título do Risco / Gap", "Severidade", "Descrição da Fragilidade", "Afirmação", "Cód. Controle", "Controle Mitigante", "Tipo", "Natureza", "Frequência", "Avaliação TOD", "Recomendação / Plano"]
    ws_rcm.row_dimensions[4].height = 28
    for i, h in enumerate(rcm_headers, 1):
        c = ws_rcm.cell(4, i, h)
        c.fill = fill_navy
        c.font = font_hdr
        c.alignment = align_hdr
        c.border = border_all
    for idx, item in enumerate(data.get("rcmRows", []), start=5):
        ws_rcm.row_dimensions[idx].height = 42
        sev = item.get("severity", "")
        zf = fill_zebra if idx % 2 == 1 else PatternFill("solid", fgColor="FFFFFF")
        vals = [
            item.get("riskCode", ""), item.get("riskTitle", ""), sev, item.get("riskDesc", ""),
            item.get("assertion", ""), item.get("controlCode", "SEM CONTROLE"), item.get("controlName", ""),
            item.get("controlType", ""), item.get("controlNature", ""), item.get("controlFreq", ""),
            item.get("todStatus", ""), item.get("recommendation", "")
        ]
        for c_i, v in enumerate(vals, 1):
            c = ws_rcm.cell(idx, c_i, v)
            c.font = font_bold if c_i in (1, 2, 3, 6) else font_cell
            c.fill = fill_red if (c_i == 3 and sev == "Alto") else (fill_amber if (c_i == 3 and sev == "Médio") else zf)
            c.alignment = align_center if c_i in (1, 3, 6, 8, 9, 10) else align_wrap
            c.border = border_all
    ws_rcm.freeze_panes = "A5"
    for i, w in enumerate([11, 34, 12, 42, 18, 14, 34, 13, 13, 15, 22, 42], 1):
        ws_rcm.column_dimensions[get_column_letter(i)].width = w

    # =========================================================================
    # ABA 4: WALKTHROUGH 5W2H, PONTOS EM ABERTO & NARRATIVA
    # =========================================================================
    ws_wp = wb.create_sheet("04_Walkthrough_5W2H")
    setup_banner(ws_wp, f"PAPEL DE TRABALHO: NARRATIVA, 5W2H & PONTOS EM ABERTO", topic, 8)
    ws_wp.cell(4, 1, "Narrativa Executiva do Walkthrough:").font = font_bold
    ws_wp.merge_cells("A5:H8")
    c_nar = ws_wp.cell(5, 1, data.get("narrative") or data.get("coachingTip") or "")
    c_nar.alignment = align_wrap
    c_nar.font = font_cell
    c_nar.fill = fill_zebra
    for r in range(5, 9):
        ws_wp.row_dimensions[r].height = 24

    row_cursor = 10
    ws_wp.cell(row_cursor, 1, "Mapeamento de Etapas (5W2H)").font = font_bold
    row_cursor += 1
    for i, h in enumerate(["Etapa", "O quê", "Quem", "Quando", "Onde / Sistema", "Por quê", "Como", "Quanto / Volume"], 1):
        c = ws_wp.cell(row_cursor, i, h)
        c.fill = fill_sub
        c.font = font_hdr
        c.alignment = align_hdr
        c.border = border_all
    ws_wp.row_dimensions[row_cursor].height = 24
    for st in data.get("steps5w2h", []):
        row_cursor += 1
        ws_wp.row_dimensions[row_cursor].height = 34
        for i, k in enumerate(["etapa", "oQue", "quem", "quando", "onde", "porQue", "como", "quanto"], 1):
            c = ws_wp.cell(row_cursor, i, st.get(k, ""))
            c.font = font_bold if i == 1 else font_cell
            c.alignment = align_wrap
            c.border = border_all

    row_cursor += 2
    ws_wp.cell(row_cursor, 1, "Pontos em Aberto & Pendências da Entrevista").font = font_bold
    row_cursor += 1
    for i, h in enumerate(["Tipo", "Descrição do Ponto em Aberto", "Status", "Origem"], 1):
        c = ws_wp.cell(row_cursor, i, h)
        c.fill = fill_navy
        c.font = font_hdr
        c.border = border_all
    for op in data.get("openPoints", []):
        row_cursor += 1
        ws_wp.row_dimensions[row_cursor].height = 26
        for i, v in enumerate([op.get("kind", ""), op.get("text", ""), op.get("status", ""), op.get("source", "")], 1):
            c = ws_wp.cell(row_cursor, i, v)
            c.font = font_cell
            c.alignment = align_wrap
            c.border = border_all
    for i, w in enumerate([22, 34, 20, 18, 24, 28, 34, 20], 1):
        ws_wp.column_dimensions[get_column_letter(i)].width = w

    # =========================================================================
    # ABA 5: ASSUNTOS DISCUTIDOS & TRANSCRIÇÃO RASTREÁVEL
    # =========================================================================
    ws_tr = wb.create_sheet("05_Assuntos_e_Registro")
    setup_banner(ws_tr, "ASSUNTOS MAPEADOS NA REUNIÃO & REGISTRO RASTREÁVEL", topic, 6)
    for i, h in enumerate(["Horário", "Categoria", "Assunto Formatado", "Síntese do Relato", "Pergunta de Auditoria", "Status"], 1):
        c = ws_tr.cell(4, i, h)
        c.fill = fill_navy
        c.font = font_hdr
        c.alignment = align_hdr
        c.border = border_all
    ws_tr.row_dimensions[4].height = 26
    r_idx = 5
    for q in data.get("questions", []):
        ws_tr.row_dimensions[r_idx].height = 36
        vals = [q.get("time") or "Roteiro", q.get("category", ""), q.get("topicTitle", ""), q.get("topicSummary", ""), q.get("text", ""), "Realizada" if q.get("asked") else "Pendente"]
        for c_i, v in enumerate(vals, 1):
            c = ws_tr.cell(r_idx, c_i, v)
            c.font = font_bold if c_i == 3 else font_cell
            c.alignment = align_wrap
            c.border = border_all
        r_idx += 1

    if data.get("includeTranscript") and data.get("transcript"):
        r_idx += 2
        ws_tr.cell(r_idx, 1, "Transcrição Rastreável da Reunião").font = font_bold
        r_idx += 1
        for i, h in enumerate(["ID", "Horário", "Participante", "Fala Registrada"], 1):
            c = ws_tr.cell(r_idx, i, h)
            c.fill = fill_sub
            c.font = font_hdr
            c.border = border_all
        for t in data.get("transcript", []):
            r_idx += 1
            ws_tr.row_dimensions[r_idx].height = 24
            for i, v in enumerate([f"T{t.get('seq', '')}", t.get("time", ""), t.get("speaker", ""), t.get("text", "")], 1):
                c = ws_tr.cell(r_idx, i, v)
                c.font = font_cell
                c.alignment = align_wrap
                c.border = border_all

    for i, w in enumerate([12, 24, 34, 46, 46, 16], 1):
        ws_tr.column_dimensions[get_column_letter(i)].width = w

    wb.save(out_path)


def main():
    if len(sys.argv) < 4:
        sys.exit(1)
    mode = sys.argv[1]
    json_in = sys.argv[2]
    out_file = sys.argv[3]

    with open(json_in, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if mode == "pbc_docx":
        build_pbc_letter_docx(payload, out_file)
    elif mode == "wp_docx":
        build_working_paper_docx(payload, out_file)
    elif mode == "audit_xlsx":
        build_audit_workbook_xlsx(payload, out_file)
    else:
        raise ValueError(f"Modo desconhecido: {mode}")


if __name__ == "__main__":
    main()

