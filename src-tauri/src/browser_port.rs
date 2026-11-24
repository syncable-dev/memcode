//! The debugging port of workers' pages. The system picks it, and it is read from the system's
//! own table by the process that listens on it, so it is never another program's.
use std::time::Duration;
use windows_sys::Win32::{
    Foundation::NO_ERROR,
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    },
    Networking::WinSock::AF_INET,
};

/// A browser listens a moment after it starts.
const ATTEMPTS: u32 = 100;
const BETWEEN: Duration = Duration::from_millis(50);

pub async fn of(browser: u32) -> Result<u16, String> {
    for _ in 0..ATTEMPTS {
        if let Some(port) = listening(browser) {
            return Ok(port);
        }
        tokio::time::sleep(BETWEEN).await;
    }
    Err("The browser for workers' pages opened no control port".into())
}

/// The port a process listens on at 127.0.0.1, if it does.
fn listening(process: u32) -> Option<u16> {
    let table = listeners()?;
    let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
    table
        .iter()
        .find(|row| row.dwOwningPid == process && row.dwLocalAddr == loopback)
        // In network byte order, in the low half.
        .map(|row| u16::from_be(row.dwLocalPort as u16))
}

fn listeners() -> Option<Vec<MIB_TCPROW_OWNER_PID>> {
    let mut size = 0u32;
    // The table can grow between asking for its size and reading it.
    for _ in 0..8 {
        // Of u32s, because the table has to be aligned like one.
        let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
        let read = unsafe {
            GetExtendedTcpTable(
                if size == 0 {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if read == NO_ERROR && !buffer.is_empty() {
            let table = buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
            return Some(unsafe {
                let rows = std::ptr::addr_of!((*table).table).cast::<MIB_TCPROW_OWNER_PID>();
                std::slice::from_raw_parts(rows, (*table).dwNumEntries as usize).to_vec()
            });
        }
        // Room for a few more than it just needed.
        size = size.saturating_add(1024);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_port_is_found_by_the_process_that_listens_on_it() {
        let own = std::process::id();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let found = listeners().unwrap();
        assert!(found.iter().any(|row| row.dwOwningPid == own
            && u16::from_be(row.dwLocalPort as u16) == port
            && row.dwLocalAddr == u32::from_ne_bytes([127, 0, 0, 1])));
        assert!(listening(own).is_some());
        assert_eq!(listening(u32::MAX), None);
    }
}
