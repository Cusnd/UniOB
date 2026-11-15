const INSTALL_AGENT_TEMPLATE: &str = include_str!("../../scripts/install.sh.tmpl");
const INSTALL_HUB_TEMPLATE: &str = include_str!("../../scripts/install-hub.sh.tmpl");

fn sanitize_shell_single_quoted(val: &str, fallback: &str) -> String {
    let cleaned: String = val
        .trim()
        .chars()
        .filter(|&c| !matches!(c, '\'' | '"' | '`' | '$' | '\\' | '\n' | '\r' | ';'))
        .collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

pub fn render_install_agent_script(github_repo: &str, origin: &str) -> String {
    let safe_repo = sanitize_shell_single_quoted(github_repo, "Cusnd/UniOB");
    let safe_origin = sanitize_shell_single_quoted(origin, "");
    let mut rendered = INSTALL_AGENT_TEMPLATE.replace("{{GITHUB_REPO}}", &safe_repo);
    rendered = rendered.replace("{{DEFAULT_ORIGIN}}", &safe_origin);
    rendered
}

pub fn render_install_hub_script(github_repo: &str, origin: &str) -> String {
    let safe_repo = sanitize_shell_single_quoted(github_repo, "Cusnd/UniOB");
    let safe_origin = sanitize_shell_single_quoted(origin, "");
    let mut rendered = INSTALL_HUB_TEMPLATE.replace("{{GITHUB_REPO}}", &safe_repo);
    rendered = rendered.replace("{{DEFAULT_ORIGIN}}", &safe_origin);
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_both_install_scripts_without_unreplaced_tokens() {
        let a = render_install_agent_script("owner/repo", "https://hub.example.com");
        assert!(a.starts_with("#!/usr/bin/env bash"));
        assert!(a.contains("TEMPLATE_REPO='owner/repo'"));
        assert!(!a.contains("{{GITHUB_REPO}}"));

        let h = render_install_hub_script("owner/repo", "https://hub.example.com");
        assert!(h.starts_with("#!/usr/bin/env bash"));
        assert!(h.contains("TEMPLATE_REPO='owner/repo'"));
        assert!(h.contains("TEMPLATE_ORIGIN='https://hub.example.com'"));
        assert!(!h.contains("{{GITHUB_REPO}}"));
        assert!(!h.contains("{{DEFAULT_ORIGIN}}"));
    }
}
