# UniOB UI Prototype · Atelier Light-First SaaS Design System (`DESIGN.md`)

## 1. Visual Philosophy
- **Visuals > Prose**: Crisp metrics, generous whitespace, quiet `6px` status shapes, and `1.5px` strokes replace explanatory banners and backend jargon.
- **Light-First Inset Sheet Frame**:
  - **Shell (`--bg-shell`)**: Warm Alabaster `#F6F6F3` (`#111110` in Matte Carbon).
  - **Sidebar (`224px`)**: Clean `32px` nav items (`机群总览`, `服务器`, `告警通知`, `服务与迁移`, `设计规范`) + compact bottom `免费额度` `18%` meter.
  - **Inset Sheet (`--bg-sheet`)**: Crisp `#FFFFFF` (`#171716` in dark mode), `14px` radius, `1px` hairline border, generous `32px` canvas padding.
- **92 / 5 / 3 Color Restraint**:
  - **92% Neutral Paper & White**
  - **5% Obsidian Ink (`#18181B`) & Youthful Accent (`#3D5AFE` Cobalt / `#E5484D` Vermilion / `#16A34A` Jade)**
  - **3% Quiet Semantic Status**

## 2. Core Tokens (`src/styles/tokens.css`)
| Token | Light Paper | Matte Carbon |
| --- | --- | --- |
| `--bg-shell` | `#F6F6F3` | `#111110` |
| `--bg-sheet` | `#FFFFFF` | `#171716` |
| `--bg-card` | `#FFFFFF` | `#1C1C1A` |
| `--text-primary` | `#18181B` | `#F4F4F1` |
| `--border-hairline` | `rgba(24, 24, 27, 0.065)` | `rgba(255, 255, 255, 0.07)` |
| `--accent` | `#3D5AFE` | `#687EFF` |
