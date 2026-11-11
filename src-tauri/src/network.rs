//! Shared API transport. macOS proxy exceptions must be evaluated per URL,
//! including redirects, rather than deciding once for an entire client.

pub(crate) fn client_builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "macos")]
    {
        let env = macos::Environment::read();
        let exclusions = std::env::var("NO_PROXY")
            .or_else(|_| std::env::var("no_proxy"))
            .unwrap_or_default();
        // An explicit custom proxy disables reqwest's automatic system proxy,
        // which currently reads the proxy address but ignores ExceptionsList.
        builder.proxy(macos::proxy_with_exclusions(
            move |url| env.proxy_for(url),
            &exclusions,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::{
        array::{CFArray, CFArrayRef},
        base::{CFType, TCFType},
        dictionary::{CFDictionary, CFDictionaryRef},
        number::CFNumber,
        string::{CFString, CFStringRef},
        url::{CFURLCreateWithString, CFURL},
    };
    use reqwest::Url;

    pub(super) fn proxy_with_exclusions(
        choose: impl Fn(&Url) -> Option<String> + Send + Sync + 'static,
        exclusions: &str,
    ) -> reqwest::Proxy {
        // reqwest 0.13.4 stores, but does not evaluate, NoProxy on custom
        // proxies. Reuse its underlying matcher to retain NO_PROXY semantics.
        let matcher = hyper_util::client::proxy::matcher::Matcher::builder()
            .all("http://proxy.invalid")
            .no(exclusions)
            .build();
        reqwest::Proxy::custom(move |url| {
            let uri = url.as_str().parse().ok()?;
            matcher.intercept(&uri)?;
            choose(url)
        })
    }

    #[link(name = "CFNetwork", kind = "framework")]
    extern "C" {
        fn CFNetworkCopySystemProxySettings() -> CFDictionaryRef;
        fn CFNetworkCopyProxiesForURL(
            url: core_foundation::url::CFURLRef,
            settings: CFDictionaryRef,
        ) -> CFArrayRef;
        static kCFProxyTypeKey: CFStringRef;
        static kCFProxyTypeNone: CFStringRef;
        static kCFProxyHostNameKey: CFStringRef;
        static kCFProxyPortNumberKey: CFStringRef;
    }

    #[derive(Default)]
    pub(super) struct Environment {
        http: Option<String>,
        https: Option<String>,
        all: Option<String>,
    }

    impl Environment {
        pub(super) fn read() -> Self {
            fn first(keys: &[&str]) -> Option<String> {
                keys.iter()
                    .filter_map(|key| std::env::var(key).ok())
                    .find(|value| !value.is_empty())
            }
            Self {
                // Preserve reqwest/curl's protection against CGI HTTP_PROXY injection.
                http: if std::env::var_os("REQUEST_METHOD").is_some() {
                    first(&["http_proxy"])
                } else {
                    first(&["HTTP_PROXY", "http_proxy"])
                },
                https: first(&["HTTPS_PROXY", "https_proxy"]),
                all: first(&["ALL_PROXY", "all_proxy"]),
            }
        }

        pub(super) fn proxy_for(&self, url: &Url) -> Option<String> {
            let explicit = match url.scheme() {
                "http" => self.http.as_ref(),
                "https" => self.https.as_ref(),
                _ => return None,
            }
            .or(self.all.as_ref());
            // Explicit environment proxies keep precedence over system settings.
            explicit.cloned().or_else(|| system_proxy(url))
        }
    }

    fn system_proxy(url: &Url) -> Option<String> {
        // Read on each decision so long-lived MR clients see VPN/proxy changes.
        let raw = unsafe { CFNetworkCopySystemProxySettings() };
        if raw.is_null() {
            return None;
        }
        let settings: CFDictionary<CFString, CFType> =
            unsafe { TCFType::wrap_under_create_rule(raw) };
        proxy_from_settings(url, &settings)
    }

    fn proxy_from_settings(url: &Url, settings: &CFDictionary<CFString, CFType>) -> Option<String> {
        // Keep the existing HTTP/HTTPS system-proxy scope. PAC execution and
        // SOCKS system proxies are not supported by reqwest's system matcher.
        // Let CFNetwork interpret macOS wildcard, CIDR and simple-host rules.
        let keys = [
            "HTTPEnable",
            "HTTPProxy",
            "HTTPPort",
            "HTTPSEnable",
            "HTTPSProxy",
            "HTTPSPort",
            "ExceptionsList",
            "ExcludeSimpleHostnames",
        ];
        let pairs: Vec<_> = keys
            .iter()
            .filter_map(|key| {
                let key = CFString::new(key);
                settings.find(&key).map(|value| (key, (*value).clone()))
            })
            .collect();
        let settings = CFDictionary::from_CFType_pairs(&pairs);
        // Proxy choice only needs the origin; never pass tokens/URL credentials.
        let origin = CFString::new(&format!("{}/", url.origin().ascii_serialization()));
        let raw_url = unsafe {
            CFURLCreateWithString(
                std::ptr::null(),
                origin.as_concrete_TypeRef(),
                std::ptr::null(),
            )
        };
        if raw_url.is_null() {
            return None;
        }
        let native_url: CFURL = unsafe { TCFType::wrap_under_create_rule(raw_url) };
        let raw = unsafe {
            CFNetworkCopyProxiesForURL(
                native_url.as_concrete_TypeRef(),
                settings.as_concrete_TypeRef(),
            )
        };
        if raw.is_null() {
            return None;
        }
        let proxies: CFArray<CFType> = unsafe { TCFType::wrap_under_create_rule(raw) };
        let first = proxies.get(0)?;
        let dictionary = first.downcast::<CFDictionary>()?;
        // CFNetwork returns dictionaries with CFString keys and CFType values.
        let proxy: CFDictionary<CFString, CFType> =
            unsafe { TCFType::wrap_under_get_rule(dictionary.as_concrete_TypeRef()) };
        let kind = proxy
            .find(unsafe { kCFProxyTypeKey })?
            .downcast::<CFString>()?;
        let direct: CFString = unsafe { TCFType::wrap_under_get_rule(kCFProxyTypeNone) };
        if kind == direct {
            return None;
        }
        let host = proxy
            .find(unsafe { kCFProxyHostNameKey })?
            .downcast::<CFString>()?
            .to_string();
        let port = proxy
            .find(unsafe { kCFProxyPortNumberKey })?
            .downcast::<CFNumber>()?
            .to_i32()?;
        if !(1..=65535).contains(&port) {
            return None;
        }
        let mut address = Url::parse("http://localhost").ok()?;
        address.set_host(Some(&host)).ok()?;
        address.set_port(Some(port as u16)).ok()?;
        Some(address.into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn settings(port: i32) -> CFDictionary<CFString, CFType> {
            let exceptions = CFArray::from_CFTypes(&[
                CFString::new("*.company.test"),
                CFString::new("10.0.0.0/8"),
                CFString::new("127.0.0.0/8"),
            ]);
            CFDictionary::from_CFType_pairs(&[
                (CFString::new("HTTPEnable"), CFNumber::from(1).as_CFType()),
                (
                    CFString::new("HTTPProxy"),
                    CFString::new("127.0.0.1").as_CFType(),
                ),
                (CFString::new("HTTPPort"), CFNumber::from(port).as_CFType()),
                (CFString::new("HTTPSEnable"), CFNumber::from(1).as_CFType()),
                (
                    CFString::new("HTTPSProxy"),
                    CFString::new("127.0.0.1").as_CFType(),
                ),
                (CFString::new("HTTPSPort"), CFNumber::from(port).as_CFType()),
                (CFString::new("ExceptionsList"), exceptions.as_CFType()),
                (
                    CFString::new("ExcludeSimpleHostnames"),
                    CFNumber::from(1).as_CFType(),
                ),
            ])
        }

        #[test]
        fn macos_exceptions_bypass_but_public_hosts_keep_proxy() {
            let settings = settings(7899);
            for scheme in ["http", "https"] {
                for host in ["gitlab.company.test", "10.13.0.253", "intranet"] {
                    let url = Url::parse(&format!("{scheme}://{host}/api/v4/user")).unwrap();
                    assert_eq!(proxy_from_settings(&url, &settings), None, "{url}");
                }
                for host in ["github.com", "notcompany.test", "company.test.example.com"] {
                    let url = Url::parse(&format!("{scheme}://{host}/")).unwrap();
                    assert_eq!(
                        proxy_from_settings(&url, &settings).as_deref(),
                        Some("http://127.0.0.1:7899/"),
                        "{url}"
                    );
                }
            }
        }

        #[test]
        fn redirects_recheck_bypass_and_no_proxy_remains_supported() {
            use std::io::{BufRead, BufReader, Write};
            use std::net::TcpListener;
            use std::time::Duration;

            fn serve(listener: TcpListener, response: String) -> std::thread::JoinHandle<String> {
                std::thread::spawn(move || {
                    listener.set_nonblocking(true).unwrap();
                    let deadline = std::time::Instant::now() + Duration::from_secs(5);
                    let mut stream = loop {
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(
                                    std::time::Instant::now() < deadline,
                                    "request never arrived"
                                );
                                std::thread::sleep(Duration::from_millis(10));
                            }
                            Err(error) => panic!("{error}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    reader.read_line(&mut request).unwrap();
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                    }
                    stream.write_all(response.as_bytes()).unwrap();
                    request
                })
            }

            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = proxy.local_addr().unwrap().port();
            let direct = TcpListener::bind("127.0.0.1:0").unwrap();
            let destination = format!("http://{}/done", direct.local_addr().unwrap());
            let proxy_worker = serve(proxy, format!("HTTP/1.1 302 Found\r\nLocation: {destination}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
            let direct_worker = serve(
                direct,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
            );
            runtime.block_on(async {
                let client = reqwest::Client::builder()
                    .proxy(proxy_with_exclusions(
                        move |url| proxy_from_settings(url, &settings(i32::from(port))),
                        "",
                    ))
                    .timeout(Duration::from_secs(3))
                    .build()
                    .unwrap();
                assert_eq!(
                    client
                        .get("http://public.example/start")
                        .send()
                        .await
                        .unwrap()
                        .text()
                        .await
                        .unwrap(),
                    "ok"
                );
            });
            assert!(proxy_worker
                .join()
                .unwrap()
                .starts_with("GET http://public.example/start "));
            assert!(direct_worker.join().unwrap().starts_with("GET /done "));

            let direct = TcpListener::bind("127.0.0.1:0").unwrap();
            let destination = format!("http://{}/env-bypass", direct.local_addr().unwrap());
            let worker = serve(
                direct,
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            );
            runtime.block_on(async {
                let client = reqwest::Client::builder()
                    .proxy(proxy_with_exclusions(
                        |_| Some("http://127.0.0.1:9".into()),
                        "127.0.0.1",
                    ))
                    .timeout(Duration::from_secs(3))
                    .build()
                    .unwrap();
                assert!(client
                    .get(destination)
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .is_success());
            });
            assert!(worker.join().unwrap().starts_with("GET /env-bypass "));
        }

        #[test]
        fn explicit_environment_proxy_keeps_precedence_and_credentials() {
            let env = Environment {
                http: Some("http://user:password@localhost:8888".into()),
                all: Some("http://localhost:9999".into()),
                ..Default::default()
            };
            assert_eq!(
                env.proxy_for(&Url::parse("http://gitlab.company.test").unwrap()),
                env.http
            );
            assert_eq!(
                env.proxy_for(&Url::parse("https://gitlab.company.test").unwrap()),
                env.all
            );
        }
    }
}
