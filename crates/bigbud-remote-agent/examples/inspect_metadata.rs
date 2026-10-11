//! Explicitly built qualification binary. Not packaged or used by production discovery.
#[cfg(windows)]
fn main() -> std::io::Result<()> {
    use bigbud_remote_agent::inspect_local::metadata;
    let args: Vec<_> = std::env::args().skip(1).collect();
    let pid = args
        .first()
        .ok_or_else(|| std::io::Error::other("pid required"))?
        .parse::<u32>()
        .map_err(std::io::Error::other)?;
    if args.len() == 2 {
        let (member, identity) = metadata::membership(pid, &args[1])?;
        println!("MEMBER\t{}\t{identity}", u8::from(member));
    } else if args.len() == 1 {
        let value = metadata::probe(pid)?;
        let path = value
            .path
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        println!(
            "OBSERVED\t{}\t{path}\t{}\t{}",
            value.birth, value.identity, value.shm_identity
        );
    } else {
        return Err(std::io::Error::other("invalid probe arguments"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Windows qualification only",
    ))
}
