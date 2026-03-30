# 🤖 Multi Purpose Agent — Hungpixi Edition v2.0

> **Fork cải tiến** từ [Rodhayl/multi-purpose-agent](https://github.com/Rodhayl/multi-purpose-agent) bởi [hungpixi](https://github.com/hungpixi) | [Comarai Agency](https://comarai.com)

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/hungpixi/multi-purpose-agent)
[![License](https://img.shields.io/badge/license-ISC-green.svg)](LICENSE.md)
[![Made with ❤️](https://img.shields.io/badge/Made%20with-❤️%20by%20hungpixi-red)](https://comarai.com)

## 🎯 Tại Sao Fork Này Tồn Tại?

Extension gốc **Multi Purpose Agent** của Rodhayl là công cụ auto-accept tuyệt vời cho các IDE dựa trên VS Code. Tuy nhiên, khi sử dụng thực tế trên **Antigravity IDE**, tôi gặp phải nhiều vấn đề pain-point mà bản gốc chưa giải quyết:

| Vấn đề gốc | Bản gốc | ✅ Hungpixi Edition |
|-------------|---------|---------------------|
| CMD popup hiện mỗi lần restart | `.bat` file flash CMD window | Pure PowerShell, `windowsHide: true` — zero popup |
| Accept chậm 1-2 giây | Poll interval 2000ms | Poll 300ms — gần như instant |
| "Step Input Required" phải bấm thủ công | Không xử lý | Auto-expand collapsed sections |
| Antigravity.exe path cứng | Chỉ check 1 location | Multi-path discovery (4+ locations) |
| Chỉ detect Accept buttons | 6 patterns | 8+ patterns (`submit`, `send`, `allow`) |

## 💡 Quá Trình Tư Duy

### 1. Phân Tích Root Cause
Reverse-engineer VSIX gốc bằng cách extract → đọc source → trace flow:
- `relauncher.js`: Tạo `.bat` file → `spawn powershell` → run batch → CMD flash → Antigravity.exe không tìm thấy
- `full_cdp_script.js`: `pollInterval || 1000` + `pollFrequency = 2000` — quá chậm
- Không có logic auto-expand cho UI collapsed states

### 2. Giải Pháp Khác Biệt

**Relaunch**: Bỏ hoàn toàn batch file trung gian. Dùng PowerShell native với `windowsHide: true` + `detached: true`. Search multiple exe paths.

**Polling**: Giảm xuống 300ms browser-side, 500ms extension-side. Đủ nhanh để user không cảm nhận delay, đủ chậm để không gây CPU spike.

**Step Input**: Thêm `autoExpandStepInputSections()` — scan DOM cho `aria-expanded="false"`, `<details>`, collapsed classes → auto-click expand → accept buttons hiện ra → click ngay.

### 3. Hướng Đi Tương Lai

- [ ] **MutationObserver** thay polling — zero CPU khi idle, instant response khi button xuất hiện
- [ ] **Configurable patterns** — user tự define accept/reject button patterns
- [ ] **Smart step input** — auto-fill textarea rồi submit (cho workflow automation)
- [ ] **Multi-IDE support** — test trên Cursor, Windsurf, Trae
- [ ] **Branding**: Custom status bar icon + panel UI cho Comarai

## 🚀 Cài Đặt

### Từ VSIX file (推薦)
```bash
# Antigravity IDE
antigravity --install-extension hungpixi-multi-purpose-agent-2.0.0.vsix --force

# VS Code
code --install-extension hungpixi-multi-purpose-agent-2.0.0.vsix --force
```

### Build từ source
```bash
git clone https://github.com/hungpixi/multi-purpose-agent.git
cd multi-purpose-agent
npm install
npm run compile
npx vsce package
```

## ⚙️ Cấu Hình

| Setting | Default | Mô tả |
|---------|---------|--------|
| `auto-accept.cdpPort` | `0` (auto) | Chrome DevTools Protocol port. 0 = auto-discover |
| `auto-accept.schedule.enabled` | `false` | Bật scheduled prompts |
| `auto-accept.schedule.silenceTimeout` | `30` | Giây chờ trước khi coi task hoàn thành |
| `auto-accept.antigravityQuota.enabled` | `true` | Hiển thị Antigravity quota trên status bar |

## 📁 Cấu Trúc Project

```
├── main_scripts/
│   ├── extension-impl.js    # Core extension logic
│   ├── relauncher.js         # IDE restart with CDP flag (FIXED)
│   ├── cdp-handler.js        # Chrome DevTools Protocol handler
│   ├── cdp-discovery.js      # Auto-discover CDP ports
│   ├── full_cdp_script.js    # Browser-side injection script (OPTIMIZED)
│   ├── auto_accept.js        # Button click logic
│   ├── debug-handler.js      # Debug mode API
│   ├── settings-panel.js     # Settings webview
│   └── utils.js              # Utilities
├── extension.js              # Entry point
├── package.json              # Extension manifest
├── build.bat                 # Build script
└── stop_all_processes.bat    # Cleanup script
```

## 🔧 Tech Stack

- **Runtime**: Node.js (VS Code Extension API)
- **Browser Communication**: Chrome DevTools Protocol (CDP)
- **Bundler**: esbuild
- **WebSocket**: ws@8.x
- **Packaging**: @vscode/vsce

## 📜 Credits

- **Original Author**: [Rodhayl](https://github.com/Rodhayl/multi-purpose-agent)  
- **Fork & Improvements**: [hungpixi](https://github.com/hungpixi) — [Comarai Agency](https://comarai.com)

## 📄 License

ISC License — xem [LICENSE.md](LICENSE.md)

---

## 🤝 Bạn muốn Extension tương tự cho IDE của bạn?

| Bạn cần | Chúng tôi đã làm ✅ |
|---------|---------------------|
| Auto-accept cho Cursor/Windsurf | Fork + customize extension |
| Workflow automation | Scheduled prompts + queue |
| Custom AI agent integration | CDP handler + debug API |
| IDE branding | Custom status bar + panel |

<p align="center">
  <a href="https://comarai.com"><img src="https://img.shields.io/badge/🌐_Yêu_cầu_Demo-comarai.com-blue?style=for-the-badge" alt="Demo"></a>
  <a href="https://zalo.me/0834422439"><img src="https://img.shields.io/badge/💬_Zalo-0834422439-green?style=for-the-badge" alt="Zalo"></a>
  <a href="mailto:hungphamphunguyen@gmail.com"><img src="https://img.shields.io/badge/📧_Email-Liên_hệ-red?style=for-the-badge" alt="Email"></a>
</p>

> 💡 *"Code tốt không phải biết viết code — mà là biết đọc code người khác, tìm ra pain-point, và fix nó tốt hơn."* — hungpixi
