## Odoo Integration
## Data sync
### Why
- Avaliability and price of items may change through out the day
- Redis needs updated avaliabillity and prices
### Proposal
- a sync hook 
    - Odoo save an item to a queue on write if avalibility or price or other data changes
    - We let a worker polls that queue
```
Every few seconds:
    read pending sync jobs from Odoo
    fetch latest product data
    update Redis
    mark job done
```

## POS integration
- On order confirmation, send the cart to the odoo backend to place an order
- expose a odoo api

### Risks
- if avaliabillity changes when customer is mid flow -> cart_controller catches it -> throw
- If price changes when customer already added items to cart -> call odoo pos at order confirmation -> real price still show up before customer confirm

## Future features
- Let llm request water/napkins items of this nature via a odoo addon
- Text to speech so it feels more "alive" and interactive
- 

