
### wizard.directed.generate
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 1/1 | 0 | — | 11266+0+0 | 1546 | $0.0570 | $0.0570 | 26.0 | 26.0 |
| 5.5 adaptive | 0/1 | 1 | max_tokens max_tokens | 31055+0+0 | 8192 | $0.1440 | $0.1440 | 65.2 | 65.2 |
| 5.5 between_tools | 1/1 | 0 | — | 15507+0+0 | 2964 | $0.0607 | $0.0607 | 22.1 | 22.1 |

### grocery.generate_list
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 2/2 | 0 | — | 3213+0+0 | 286 | $0.0139 | $0.0070 | 0.0 | 3.9 |
| 5.5 adaptive | 2/2 | 0 | — | 4431+0+0 | 247 | $0.0113 | $0.0057 | 0.0 | 2.3 |
| 5.5 between_tools | 1/1 | 0 | — | 4429+0+0 | 247 | $0.0113 | $0.0113 | 2.5 | 2.5 |

### import.reformat_for_kiwi
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 1/1 | 0 | — | 4789+0+0 | 1628 | $0.0388 | $0.0388 | 19.2 | 19.2 |
| 5.5 adaptive | 1/1 | 0 | — | 6529+0+0 | 2622 | $0.0393 | $0.0393 | 15.7 | 15.7 |
| 5.5 between_tools | 1/1 | 0 | — | 6527+0+0 | 1797 | $0.0310 | $0.0310 | 10.6 | 10.6 |

### recipes.scale_ingredients
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 1/1 | 0 | — | 877+0+0 | 181 | $0.0053 | $0.0053 | 2.6 | 2.6 |
| 5.5 adaptive | 1/1 | 0 | — | 1219+0+0 | 273 | $0.0052 | $0.0052 | 2.3 | 2.3 |
| 5.5 between_tools | 1/1 | 0 | — | 1217+0+0 | 270 | $0.0051 | $0.0051 | 2.4 | 2.4 |

### wizard.set_preferences.generate
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 2/3 | 0 | max_tokens | 12207+11160+5580 | 6468 | $0.1579 | $0.0526 | 23.9 | 71.8 |
| 5.5 adaptive | 0/3 | 0 | max_tokens max_tokens max_tokens | 17607+15676+7838 | 12288 | $0.1808 | $0.0603 | 32.4 | 33.3 |
| 5.5 between_tools | 3/3 | 0 | — | 17607+15674+7837 | 4989 | $0.1078 | $0.0359 | 11.8 | 13.9 |
first-candidate ms: A/family4picky=8200 · A/gf30=8294 · C/family4picky=4861 · C/med2=3860 · C/gf30=5066

### prep.narrate_steps
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 4/5 | 1 | — | 70450+0+0 | 13266 | $0.4103 | $0.0821 | 24.8 | 77.4 |
| 5.5 adaptive | 5/5 | 0 | — | 76323+0+0 | 30107 | $0.4537 | $0.0907 | 30.9 | 56.7 |
| 5.5 between_tools | 5/5 | 0 | — | 76318+0+0 | 14084 | $0.2935 | $0.0587 | 14.4 | 19.9 |

### wizard.candidate.expand
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 5/5 | 0 | — | 32922+0+0 | 5007 | $0.1739 | $0.0348 | 10.1 | 16.5 |
| 5.5 adaptive | 5/5 | 0 | — | 42480+0+0 | 14611 | $0.2311 | $0.0462 | 19.8 | 28.4 |
| 5.5 between_tools | 5/5 | 0 | — | 42475+0+0 | 9776 | $0.1827 | $0.0365 | 11.7 | 16.7 |

### wizard.candidate.finalize_steps
| arm | pass | retries | stops≠ok | in tok (uncached+cacheRd+cacheWr) | out tok | cost total | cost/call | p50 s | max s |
|---|---|---|---|---|---|---|---|---|---|
| 4.6 (today) | 5/5 | 0 | — | 26560+0+0 | 4649 | $0.1494 | $0.0299 | 12.4 | 17.4 |
| 5.5 adaptive | 5/5 | 0 | — | 33886+0+0 | 7105 | $0.1388 | $0.0278 | 6.5 | 15.6 |
| 5.5 between_tools | 5/5 | 0 | — | 33881+0+0 | 7839 | $0.1462 | $0.0292 | 9.5 | 13.3 |

total measured spend $3.054 (+$0.003 for p0)
