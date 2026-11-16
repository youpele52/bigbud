fn execute() -> std::io::Result<i32> {
    let executable = std::env::current_exe()?;
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "--bigbud-cli-install-v1")
    {
        let mut args = arguments.iter().skip(1);
        let destination = args
            .next()
            .ok_or_else(|| std::io::Error::other("missing destination"))?;
        let runtime = args
            .next()
            .ok_or_else(|| std::io::Error::other("missing runtime"))?;
        let entry = args
            .next()
            .ok_or_else(|| std::io::Error::other("missing entry"))?;
        if args.next().is_some() {
            return Err(std::io::Error::other("invalid install arguments"));
        }
        bigbud_cli_launcher::install::install(
            &executable,
            std::path::Path::new(destination),
            std::path::Path::new(runtime),
            std::path::Path::new(entry),
        )?;
        println!("installed");
        return Ok(0);
    }
    bigbud_cli_launcher::run(&executable, arguments)
}
fn main() {
    let code = match execute() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("bigbud: cannot launch or install bundled CLI: {error}");
            1
        }
    };
    // Preserve the child's full Windows exit code instead of truncating it to an ExitCode u8.
    #[allow(clippy::exit)]
    std::process::exit(code);
}
