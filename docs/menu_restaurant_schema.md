# Menu & Restaurant Data Schema — `jadegarden1`

Schema reference for menu items and restaurant data (Odoo POS).

> **Note:** `name` / `description` fields are `jsonb` — Odoo stores translatable text as `{"en_US": "...", ...}`.

## 🍽️ Menu Items

### `product_template` — the menu item (56 cols)
Key fields:
- `name` (jsonb), `list_price`, `default_code`, `alternative_name`
- `categ_id` → `product_category`, `uom_id`
- POS: `available_in_pos`, `self_order_available`, `pos_sequence`, `to_weight`, `public_description`
- `has_configurable_attributes`, `type`, `service_type`, `active`

### `product_product` — sellable variant of a template
- `product_tmpl_id` → `product_template`, `barcode`, `combination_indices`, `standard_price`, `alternative_name`

### Categories
- **`product_category`** — accounting/inventory tree (`parent_id`, `complete_name`, `parent_path`)
- **`pos_category`** — POS menu categories on screen (`parent_id`, `sequence`, `color`, `hour_after` / `hour_until` for time-based visibility)
- Link: `pos_category_product_template_rel` (products ↔ POS category)

### Attributes / modifiers (size, options, etc.)
- **`product_attribute`** — attribute definition (`display_type`, `create_variant`)
- **`product_attribute_value`** — possible values (`attribute_id`, `default_extra_price`, `html_color`, `is_custom`)
- **`product_template_attribute_line`** — attaches an attribute to a template (`product_tmpl_id`, `attribute_id`)
- **`product_template_attribute_value`** — resolved value per template with `price_extra`

### Combos / meals
- **`product_combo`** — combo group (`name`, `qty_max`, `qty_free`)
- **`product_combo_item`** — combo choices (`combo_id`, `product_id`, `extra_price`)
- Link: `product_combo_product_template_rel` (combos ↔ templates)

### Multi-menu (menu tabs / time-based menus)
- **`pos_multi_menu`** — menu tab (`name`, `tab_order`, `start_time` / `end_time`, `auto_time_filter`)
- Links: `pos_multi_menu_product_tmpl_rel`, `pos_multi_menu_pos_category_rel`

## 🪑 Restaurant Data

- **`restaurant_floor`** — dining areas (`name`, `background_color`, `sequence`, `active`)
- **`restaurant_table`** — tables (`floor_id` → `restaurant_floor`, `table_number`, `seats`, `shape`, `color`, `position_h/v`, `width`, `height`, `identifier`, `parent_id` for merged tables)
- **`restaurant_order_course`** — course firing per order (`order_id` → `pos_order`, `index`, `fired`, `fired_date`, `uuid`)

Floors attach to a POS via `pos_config_restaurant_floor_rel`.

## Key relationships

```
restaurant_floor 1──* restaurant_table
product_template 1──* product_product                 (product_tmpl_id)
product_template *──1 product_category                (categ_id)
product_template *──* pos_category                    (pos_category_product_template_rel)
product_template 1──* product_template_attribute_line ──* product_template_attribute_value
product_attribute 1──* product_attribute_value
product_combo    1──* product_combo_item ──* product_product
pos_order        1──* restaurant_order_course
```

## Full column listings

### `restaurant_floor`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| sequence | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| name | character varying | NO |
| background_color | character varying | YES |
| active | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |

### `restaurant_table`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| floor_id | integer | YES |
| table_number | integer | NO |
| seats | integer | YES |
| parent_id | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| shape | character varying | NO |
| color | character varying | YES |
| active | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| position_h | double precision | YES |
| position_v | double precision | YES |
| width | double precision | YES |
| height | double precision | YES |
| identifier | character varying | NO |

### `restaurant_order_course`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| index | integer | YES |
| order_id | integer | NO |
| create_uid | integer | YES |
| write_uid | integer | YES |
| uuid | character varying | YES |
| fired | boolean | YES |
| fired_date | timestamp | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |

### `pos_category`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| parent_id | integer | YES |
| sequence | integer | YES |
| color | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| name | jsonb | NO |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| hour_until | double precision | YES |
| hour_after | double precision | YES |

### `product_category`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| parent_id | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| name | character varying | NO |
| complete_name | character varying | YES |
| parent_path | character varying | YES |
| product_properties_definition | jsonb | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| property_account_income_categ_id | jsonb | YES |
| property_account_expense_categ_id | jsonb | YES |
| removal_strategy_id | integer | YES |
| packaging_reserve_method | character varying | YES |
| property_valuation | jsonb | YES |
| property_cost_method | jsonb | YES |
| property_stock_journal | jsonb | YES |
| property_stock_valuation_account_id | jsonb | YES |
| property_price_difference_account_id | jsonb | YES |

### `product_template`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| sequence | integer | YES |
| categ_id | integer | YES |
| uom_id | integer | NO |
| company_id | integer | YES |
| color | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| type | character varying | NO |
| service_tracking | character varying | NO |
| default_code | character varying | YES |
| name | jsonb | NO |
| description | jsonb | YES |
| description_purchase | jsonb | YES |
| description_sale | jsonb | YES |
| product_properties | jsonb | YES |
| list_price | numeric | YES |
| volume | numeric | YES |
| weight | numeric | YES |
| sale_ok | boolean | YES |
| purchase_ok | boolean | YES |
| active | boolean | YES |
| can_image_1024_be_zoomed | boolean | YES |
| has_configurable_attributes | boolean | YES |
| is_favorite | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| property_account_income_id | jsonb | YES |
| property_account_expense_id | jsonb | YES |
| sale_delay | integer | YES |
| lot_sequence_id | integer | YES |
| tracking | character varying | NO |
| responsible_id | jsonb | YES |
| property_stock_production | jsonb | YES |
| property_stock_inventory | jsonb | YES |
| description_picking | jsonb | YES |
| description_pickingout | jsonb | YES |
| description_pickingin | jsonb | YES |
| is_storable | boolean | YES |
| property_price_difference_account_id | jsonb | YES |
| lot_valuated | boolean | YES |
| pos_sequence | integer | YES |
| public_description | jsonb | YES |
| available_in_pos | boolean | YES |
| to_weight | boolean | YES |
| self_order_available | boolean | YES |
| tip_percentage_tax_base | character varying | YES |
| tip_percentage_values | jsonb | YES |
| tip_flat_values | jsonb | YES |
| tip_flat_min_order_total | numeric | YES |
| is_tip_percentage_product | boolean | YES |
| alternative_name | character varying | YES |
| service_type | character varying | YES |
| expense_policy | character varying | YES |
| invoice_policy | character varying | YES |
| sale_line_warn_msg | text | YES |

### `product_product`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| product_tmpl_id | integer | NO |
| create_uid | integer | YES |
| write_uid | integer | YES |
| default_code | character varying | YES |
| barcode | character varying | YES |
| combination_indices | character varying | YES |
| standard_price | jsonb | YES |
| volume | numeric | YES |
| weight | numeric | YES |
| active | boolean | YES |
| can_image_variant_1024_be_zoomed | boolean | YES |
| is_favorite | boolean | YES |
| is_in_selected_section_of_order | boolean | YES |
| write_date | timestamp | YES |
| create_date | timestamp | YES |
| lot_properties_definition | jsonb | YES |
| alternative_name | character varying | YES |

### `product_combo`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| sequence | integer | YES |
| company_id | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| name | character varying | NO |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| qty_max | integer | YES |
| qty_free | integer | YES |

### `product_combo_item`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| company_id | integer | YES |
| combo_id | integer | NO |
| product_id | integer | NO |
| create_uid | integer | YES |
| write_uid | integer | YES |
| extra_price | numeric | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |

### `product_attribute`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| sequence | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| create_variant | character varying | NO |
| display_type | character varying | NO |
| name | jsonb | NO |
| active | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |

### `product_attribute_value`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| sequence | integer | YES |
| attribute_id | integer | NO |
| color | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| html_color | character varying | YES |
| name | jsonb | NO |
| is_custom | boolean | YES |
| active | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| default_extra_price | double precision | YES |

### `product_template_attribute_line`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| product_tmpl_id | integer | NO |
| sequence | integer | YES |
| attribute_id | integer | NO |
| value_count | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| active | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |

### `product_template_attribute_value`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| product_attribute_value_id | integer | NO |
| attribute_line_id | integer | NO |
| product_tmpl_id | integer | YES |
| attribute_id | integer | YES |
| color | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| price_extra | numeric | YES |
| ptav_active | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |

### `pos_multi_menu`
| column | type | nullable |
|---|---|---|
| id | integer | NO |
| tab_order | integer | YES |
| tab_sort_order | integer | YES |
| color | integer | YES |
| create_uid | integer | YES |
| write_uid | integer | YES |
| name | jsonb | NO |
| active | boolean | YES |
| auto_time_filter | boolean | YES |
| create_date | timestamp | YES |
| write_date | timestamp | YES |
| start_time | double precision | YES |
| end_time | double precision | YES |
