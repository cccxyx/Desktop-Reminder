use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, WindowEvent,
};

fn show_window(app: &AppHandle, label: &str) {
  if let Some(window) = app.get_webview_window(label) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_window(app, "editor");
        show_window(app, "floating");
      }),
    )
    .plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .setup(|app| {
      let show_editor = MenuItem::with_id(app, "show_editor", "Open Editor", true, None::<&str>)?;
      let show_floating =
        MenuItem::with_id(app, "show_floating", "Show Floating Window", true, None::<&str>)?;
      let separator = PredefinedMenuItem::separator(app)?;
      let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show_editor, &show_floating, &separator, &quit])?;
      let tray_icon = app.default_window_icon().cloned();

      let _tray = TrayIconBuilder::with_id("desktop-reminder-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Desktop Reminder")
        .icon(
          tray_icon.expect("default tray icon should exist after tauri bundle icon generation"),
        )
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            let app = tray.app_handle();
            show_window(&app, "editor");
            show_window(&app, "floating");
          }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
          "show_editor" => show_window(app, "editor"),
          "show_floating" => show_window(app, "floating"),
          "quit" => app.exit(0),
          _ => {}
        })
        .build(app)?;

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let launched_from_autostart = std::env::args().any(|arg| arg == "--autostart");
      if launched_from_autostart {
        if let Some(editor) = app.get_webview_window("editor") {
          let _ = editor.hide();
        }
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        match window.label() {
          "editor" => {
            api.prevent_close();
            let _ = window.hide();
          }
          "floating" => {
            api.prevent_close();
            let _ = window.hide();
          }
          _ => {}
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
