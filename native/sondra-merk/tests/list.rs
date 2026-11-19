//! Taking an entry off the list and putting it back.

use serde_json::json;
use sondra_merk::list::*;
use sondra_merk::merge::Removed;
use sondra_merk::normalize::{normalize, Context};
use sondra_merk::Item;

fn item(id: &str, at: i64) -> Item {
    normalize(&json!({ "id": id, "title": id, "updatedAt": at }), &mut Context::system())
}

#[test]
fn a_removal_is_noted_and_an_undo_puts_the_entry_back_where_it_stood_changed_now() {
    let mut items = vec![item("a", 10), item("b", 20), item("c", 30)];
    let mut removed = Removed::new();
    let taken = remove_item(&mut items, &mut removed, "b", 500).unwrap();
    assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
    assert_eq!(removed.get("b"), Some(&500));
    assert_eq!(taken.index, 1);
    assert!(remove_item(&mut items, &mut removed, "zzz", 600).is_none(), "nothing to take");

    restore_item(&mut items, &mut removed, &taken, 700);
    assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    assert!(removed.is_empty(), "the removal is no longer noted");
    // The removal (500) is later than the entry's last change (20): it counts as changed now, so the next
    // round with Drive does not take it off again.
    assert_eq!(items[1].updated_at, 700);
}

#[test]
fn an_entry_changed_after_its_removal_keeps_its_time_and_a_short_list_takes_it_at_the_end() {
    let mut items = vec![item("a", 10), item("b", 20)];
    let mut removed = Removed::new();
    let mut taken = remove_item(&mut items, &mut removed, "b", 15).unwrap();
    taken.item.updated_at = 900;
    taken.index = 9;
    restore_item(&mut items, &mut removed, &taken, 1000);
    assert_eq!(items.last().unwrap().id, "b");
    assert_eq!(items.last().unwrap().updated_at, 900);
}

#[test]
fn an_entry_already_there_is_not_doubled() {
    let mut items = vec![item("a", 10)];
    let mut removed = Removed::new();
    let taken = Taken { item: item("a", 5), index: 0 };
    restore_item(&mut items, &mut removed, &taken, 100);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].updated_at, 10, "the one on the list is left as it is");
}
