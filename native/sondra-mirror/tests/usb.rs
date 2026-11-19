//! What can be said about the cable without a phone on it.

use sondra_mirror::usb::{is_adb_interface, list_phones, read_size, UsbLink};

#[test]
fn only_the_adb_interface_counts() {
    assert!(is_adb_interface(0xff, 0x42, 0x01));
    assert!(!is_adb_interface(0xff, 0x42, 0x03), "fastboot is another");
    assert!(!is_adb_interface(0x08, 0x06, 0x50), "a stick of memory");
    assert!(!is_adb_interface(0x06, 0x01, 0x01), "a camera");
}

#[test]
fn a_read_is_asked_for_in_whole_packets() {
    assert_eq!(read_size(24, 512), 512);
    assert_eq!(read_size(24, 1024), 1024);
    assert_eq!(read_size(513, 512), 1024);
    assert_eq!(read_size(1024, 512), 1024);
    assert_eq!(read_size(0, 512), 512);
    assert_eq!(read_size(100, 0), 128, "a packet size of nothing is taken as the smallest USB knows");
}

#[test]
fn with_no_phone_there_is_none_to_find_and_none_to_open() {
    // On a build machine there may be USB devices, but none of them is a phone with ADB.
    assert!(list_phones().is_empty());
    // (On a machine without any USB bus the cable cannot even be listed: still an error, in words.)
    let error = UsbLink::open("keins").err().expect("nothing to open");
    assert!(!error.to_string().is_empty());
}
