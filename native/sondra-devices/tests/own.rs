use sondra_devices::own::Own;
use sondra_drive::keystore::{KeyStore, MemoryKeyStore};

#[test]
fn an_identity_rests_and_comes_back_as_the_same_device() {
    let store = MemoryKeyStore::default();
    assert!(Own::load(&store).is_none(), "nothing kept, nothing guessed");
    let mut own = Own::create("  Arbeits-PC ", 1_700_000_000_000.0);
    assert_eq!(own.name, "Arbeits-PC");
    own.decided = true;
    own.save(&store).unwrap();
    let back = Own::load(&store).unwrap();
    assert_eq!(back.keys.id(), own.keys.id(), "the key is the device");
    assert_eq!((back.name.as_str(), back.created, back.decided), ("Arbeits-PC", 1_700_000_000_000.0, true));
    // Something that is not an identity is not one.
    store.save("kein JSON").unwrap();
    assert!(Own::load(&store).is_none());
}
