//! „Netzwerk“ in „Herunterladen“ (the website's network adapter choice, `bindAddress` of the desktop service): the
//! connections of loading can leave from the address of one adapter — a second network card, a cable beside the
//! Wi-Fi — instead of the one the system picks. Automatic is the default and leaves everything as it was.
//!
//! The choice lives here, once for the program; `agent` builds every agent of looking up and loading with it.

use std::fmt;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::RwLock;

use ureq::config::Config;
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::{
    Buffers, ConnectProxyConnector, Connector, ConnectionDetails, Either, LazyBuffers, NextTimeout, RustlsConnector, Transport,
};
use ureq::Agent;

static BIND: RwLock<Option<IpAddr>> = RwLock::new(None);

/// The address connections leave from, or `None` for the system's choice.
pub fn bind_address() -> Option<IpAddr> {
    *BIND.read().unwrap_or_else(|e| e.into_inner())
}

pub fn set_bind_address(address: Option<IpAddr>) {
    *BIND.write().unwrap_or_else(|e| e.into_inner()) = address;
}

/// An adapter of this computer: its name and an address of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adapter {
    pub name: String,
    pub address: IpAddr,
}

/// The adapters with an address outside the computer itself (no loopback), IPv4 first.
pub fn adapters() -> Vec<Adapter> {
    let mut list: Vec<Adapter> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter(|i| !matches!(i.ip(), IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80))
        .map(|i| Adapter { name: i.name.clone(), address: i.ip() })
        .collect();
    list.sort_by_key(|a| (a.address.is_ipv6(), a.name.clone()));
    list.dedup();
    list
}

/// An agent of this configuration that connects from the chosen address — or the usual one when there is none.
pub fn agent(config: Config) -> Agent {
    match bind_address() {
        None => config.new_agent(),
        Some(from) => {
            let connector = ().chain(ConnectProxyConnector::default()).chain(BoundTcp { from }).chain(RustlsConnector::default());
            Agent::with_parts(config, connector, DefaultResolver::default())
        }
    }
}

/// Opens the TCP connection from one address (as ureq's own `TcpConnector`, with a bind before the connect).
struct BoundTcp {
    from: IpAddr,
}

impl fmt::Debug for BoundTcp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BoundTcp").field("from", &self.from).finish()
    }
}

impl<In: Transport> Connector<In> for BoundTcp {
    type Out = Either<In, BoundTransport>;

    fn connect(&self, details: &ConnectionDetails, chained: Option<In>) -> Result<Option<Self::Out>, ureq::Error> {
        if chained.is_some() {
            return Ok(chained.map(Either::A));
        }
        let mut last: Option<std::io::Error> = None;
        // Only addresses of the family of the chosen one can be reached from it.
        for to in details.addrs.iter().filter(|a| a.is_ipv4() == self.from.is_ipv4()) {
            match connect_from(self.from, *to) {
                Ok(stream) => {
                    let config = &details.config;
                    let buffers = LazyBuffers::new(config.input_buffer_size(), config.output_buffer_size());
                    return Ok(Some(Either::B(BoundTransport { stream, buffers })));
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.map_or_else(|| ureq::Error::ConnectionFailed, ureq::Error::Io))
    }
}

fn connect_from(from: IpAddr, to: SocketAddr) -> std::io::Result<TcpStream> {
    use socket2::{Domain, Protocol, Socket, Type};
    let socket = Socket::new(Domain::for_address(to), Type::STREAM, Some(Protocol::TCP))?;
    socket.bind(&SocketAddr::new(from, 0).into())?;
    socket.connect_timeout(&to.into(), std::time::Duration::from_secs(30))?;
    socket.set_tcp_nodelay(true)?;
    Ok(socket.into())
}

/// A TCP connection as a transport for ureq (its own `TcpTransport` is not public).
pub struct BoundTransport {
    stream: TcpStream,
    buffers: LazyBuffers,
}

impl fmt::Debug for BoundTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BoundTransport").field("peer", &self.stream.peer_addr().ok()).finish()
    }
}

fn timed_out(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

impl Transport for BoundTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        use std::io::Write;
        let timeout = timeout.for_write();
        self.stream.set_write_timeout(timeout.not_zero().map(|d| *d))?;
        let output = &self.buffers.output()[..amount];
        match (&self.stream).write_all(output) {
            Ok(()) => Ok(()),
            Err(e) if timed_out(&e) => Err(ureq::Error::Timeout(timeout.reason)),
            Err(e) => Err(e.into()),
        }
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        use std::io::Read;
        let timeout = timeout.for_read();
        self.stream.set_read_timeout(timeout.not_zero().map(|d| *d))?;
        let input = self.buffers.input_append_buf();
        let amount = loop {
            match (&self.stream).read(input) {
                Ok(n) => break n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if timed_out(&e) => return Err(ureq::Error::Timeout(timeout.reason)),
                Err(e) => return Err(e.into()),
            }
        };
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        use std::io::Read;
        if self.stream.set_nonblocking(true).is_err() {
            return false;
        }
        let mut one = [0u8];
        let open = matches!((&self.stream).read(&mut one), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock);
        open && self.stream.set_nonblocking(false).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chosen_address_is_where_the_connection_comes_from() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (mut stream, peer) = server.accept().unwrap();
            use std::io::{Read, Write};
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nja");
            peer.ip()
        });
        set_bind_address(Some("127.0.0.1".parse().unwrap()));
        let agent = agent(Agent::config_builder().build());
        let body = agent.get(&format!("http://127.0.0.1:{port}/")).call().unwrap().body_mut().read_to_string().unwrap();
        set_bind_address(None);
        assert_eq!(body, "ja");
        assert_eq!(seen.join().unwrap().to_string(), "127.0.0.1");
    }
}
